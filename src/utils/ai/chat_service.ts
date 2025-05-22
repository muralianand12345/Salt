import RAG from "./rag";
import { DataSource } from "typeorm";
import { LLM, Embedding } from "./llm";
import ChatHistory from "./chat_history";
import { createDynamicTicketTool } from "./tools";
import { TicketRepository } from "../../events/database/repo/ticket_system";
import { ChatbotConfig } from "../../events/database/entities/chatbot_config";
import { RagRepository } from "../../events/database/repo/rag_data";
import discord from "discord.js";
import client from "../../salt";

/**
 * Service class for handling chatbot interactions with RAG integration and tool support
 * Manages message processing, RAG context retrieval, tool execution, and LLM responses
 */
export class ChatbotService {
    private ragRepo: RagRepository;
    private dataSource: DataSource;
    private pendingTicketCreations: Map<string, {
        categoryId: string;
        userMessage: string;
        guildId: string;
        channelId: string;
        userId: string;
        toolMessage: string;
    }> = new Map();

    constructor(dataSource: DataSource) {
        this.dataSource = dataSource;
        this.ragRepo = new RagRepository(dataSource);
    }

    /**
     * Get chatbot configuration by channel ID
     * @param channelId - Discord channel ID
     * @returns Chatbot configuration or null if not found
     */
    public getConfigByChannelId = async (channelId: string): Promise<ChatbotConfig | null> => {
        try {
            const configs = await this.dataSource.getRepository(ChatbotConfig).find();
            return configs.find(config => config.channelId === channelId) || null;
        } catch (error) {
            client.logger.error(`[CHATBOT_SERVICE] Error finding config by channel ID: ${error}`);
            return null;
        }
    };

    /**
     * Search for relevant context from RAG data
     * @param query - User's query
     * @param guildId - Discord guild ID
     * @returns Relevant context or null if no RAG data available
     */
    private searchRagContext = async (query: string, guildId: string): Promise<string | null> => {
        try {
            const hasRagData = await this.ragRepo.hasRagData(guildId);
            if (!hasRagData) {
                return null;
            }

            const embedding = new Embedding();
            const rag = new RAG(embedding);
            const queryEmbedding = await rag.getQueryEmbedding(query);

            const similarChunks = await this.ragRepo.searchSimilarChunks(
                guildId,
                queryEmbedding,
                5
            );

            if (similarChunks.length === 0) {
                return null;
            }

            const context = similarChunks
                .map((chunk, index) => `[Context ${index + 1}]\n${chunk.content}`)
                .join('\n\n');

            return context;
        } catch (error) {
            client.logger.error(`[CHATBOT_SERVICE] Error searching RAG context: ${error}`);
            return null;
        }
    };

    /**
     * Build the system prompt with optional RAG context
     * @param config - Chatbot configuration
     * @param ragContext - RAG context if available
     * @param includeTools - Whether to include tool instructions
     * @returns System prompt string
     */
    private buildSystemPrompt = (config: ChatbotConfig, ragContext: string | null, includeTools: boolean = false): string => {
        let systemPrompt = `You are ${config.chatbotName}, an AI assistant in a Discord server. `;

        if (config.responseType && config.responseType.trim().length > 0) {
            systemPrompt += `Your personality and response style: ${config.responseType}. `;
        }

        systemPrompt += `
Guidelines:
- Be helpful, informative, and engaging
- Keep responses concise but thorough
- Use Discord-friendly formatting when appropriate
- If you don't know something, say so honestly
- Stay in character as ${config.chatbotName}`;

        if (includeTools) {
            systemPrompt += `

Tool Usage Guidelines:
- Use the create_ticket tool when:
  * User explicitly asks to create a ticket
  * User is not satisfied with your response and needs human help
  * The question requires human intervention to resolve
  * Technical issues that need staff assistance
  * Complex problems that can't be solved through chat
- Choose the most appropriate ticket category based on the user's issue
- Provide a helpful message explaining why a ticket is being created`;
        }

        if (ragContext) {
            systemPrompt += `

You have access to specific knowledge about this server/topic. Use the following context to answer questions when relevant:

${ragContext}

When using this context:
- Reference the information naturally in your response
- If the context is relevant, use it to provide accurate, detailed answers
- If the context doesn't relate to the question, you can still provide general help
- Don't mention that you're using "context" or "knowledge base" explicitly`;
        }

        return systemPrompt;
    };

    /**
     * Get available ticket categories for tool usage
     * @param guildId - Discord guild ID
     * @returns Array of category IDs and names
     */
    private getTicketCategories = async (guildId: string): Promise<Array<{ id: string; name: string }>> => {
        try {
            const ticketRepo = new TicketRepository(this.dataSource);
            const categories = await ticketRepo.getTicketCategories(guildId);
            return categories
                .filter(cat => cat.isEnabled)
                .map(cat => ({ id: cat.id, name: cat.name }));
        } catch (error) {
            client.logger.error(`[CHATBOT_SERVICE] Error getting ticket categories: ${error}`);
            return [];
        }
    };

    /**
     * Process a user message and generate a response with two-stage LLM invocation
     * @param userMessage - The user's message content
     * @param userId - Discord user ID
     * @param config - Chatbot configuration
     * @param channelId - Discord channel ID
     * @returns Generated response, confirmation button, or null if failed
     */
    public processMessage = async (
        userMessage: string,
        userId: string,
        config: ChatbotConfig,
        channelId: string
    ): Promise<{
        response?: string;
        needsConfirmation?: boolean;
        confirmationEmbed?: discord.EmbedBuilder;
        confirmationButtons?: discord.ActionRowBuilder<discord.ButtonBuilder>;
    } | null> => {
        try {
            const llm = new LLM(config.apiKey, config.baseUrl);

            const chatHistory = new ChatHistory(
                this.dataSource,
                userId,
                config.guildId,
                20
            );

            const ragContext = await this.searchRagContext(userMessage, config.guildId);
            const categories = await this.getTicketCategories(config.guildId);

            // Stage 1: Check if tools need to be executed
            if (categories.length > 0) {
                const toolSystemPrompt = this.buildSystemPrompt(config, ragContext, true);
                const history = await chatHistory.getHistory();
                const filteredHistory = history.filter(msg => msg.role !== 'system');

                const toolMessages = [
                    { role: 'system' as const, content: toolSystemPrompt },
                    ...filteredHistory,
                    { role: 'user' as const, content: userMessage }
                ];

                const categoryIds = categories.map(cat => cat.id);
                const tools = createDynamicTicketTool(categories);

                const toolResponse = await llm.invoke(toolMessages, config.modelName, {
                    max_tokens: 2000,
                    temperature: 0.3,
                    tools: tools,
                    tool_choice: "auto"
                });

                const toolCalls = toolResponse.choices[0]?.message?.tool_calls;

                if (toolCalls && toolCalls.length > 0) {
                    const toolCall = toolCalls[0];

                    if (toolCall.function.name === "create_ticket") {
                        const args = JSON.parse(toolCall.function.arguments);
                        const selectedCategory = categories.find(cat => cat.name === args.ticket_category);

                        if (selectedCategory) {
                            const confirmationId = `ticket_confirm_${userId}_${Date.now()}`;
                            this.pendingTicketCreations.set(confirmationId, {
                                categoryId: selectedCategory.id,
                                userMessage,
                                guildId: config.guildId,
                                channelId,
                                userId,
                                toolMessage: args.message || "A ticket will be created to assist you with your request."
                            });

                            const confirmationEmbed = new discord.EmbedBuilder()
                                .setTitle("🎫 Create Ticket Confirmation")
                                .setDescription(
                                    `${args.message || "I'd like to create a ticket to better assist you with your request."}\n\n` +
                                    `**Category:** ${selectedCategory.name}\n` +
                                    `**Your message:** ${userMessage.length > 100 ? userMessage.substring(0, 100) + "..." : userMessage}`
                                )
                                .setColor("Blue")
                                .setFooter({ text: "This will create a private support channel for you" });

                            const confirmationButtons = new discord.ActionRowBuilder<discord.ButtonBuilder>()
                                .addComponents(
                                    new discord.ButtonBuilder()
                                        .setCustomId(`ticket_confirm_yes_${confirmationId}`)
                                        .setLabel("Create Ticket")
                                        .setStyle(discord.ButtonStyle.Success)
                                        .setEmoji("✅"),
                                    new discord.ButtonBuilder()
                                        .setCustomId(`ticket_confirm_no_${confirmationId}`)
                                        .setLabel("Cancel")
                                        .setStyle(discord.ButtonStyle.Secondary)
                                        .setEmoji("❌")
                                );

                            this.cleanupOldConfirmations();

                            await chatHistory.addUserMessage(userMessage);
                            await chatHistory.addAssistantMessage(`[Ticket creation requested for: ${args.ticket_category}]`);

                            return {
                                needsConfirmation: true,
                                confirmationEmbed,
                                confirmationButtons
                            };
                        }
                    }
                }
            }

            // Stage 2: Normal response generation (no tools needed)
            const normalSystemPrompt = this.buildSystemPrompt(config, ragContext, false);
            const history = await chatHistory.getHistory();
            const filteredHistory = history.filter(msg => msg.role !== 'system');

            const normalMessages = [
                { role: 'system' as const, content: normalSystemPrompt },
                ...filteredHistory,
                { role: 'user' as const, content: userMessage }
            ];

            const response = await llm.invoke(normalMessages, config.modelName, {
                max_tokens: 2000,
                temperature: 0.7
            });

            const assistantMessage = response.choices[0]?.message?.content;

            if (!assistantMessage) {
                client.logger.error('[CHATBOT_SERVICE] No response content from LLM');
                return null;
            }

            await chatHistory.addUserMessage(userMessage);
            await chatHistory.addAssistantMessage(assistantMessage);

            return { response: assistantMessage };

        } catch (error) {
            client.logger.error(`[CHATBOT_SERVICE] Error processing message: ${error}`);
            return null;
        }
    };

    /**
     * Handle ticket creation confirmation
     * @param confirmationId - The confirmation ID
     * @param confirmed - Whether the user confirmed
     * @returns Success message or error
     */
    public handleTicketConfirmation = async (
        confirmationId: string,
        confirmed: boolean
    ): Promise<{ success: boolean; message: string; ticketChannel?: string }> => {
        try {
            const pendingCreation = this.pendingTicketCreations.get(confirmationId);
            if (!pendingCreation) {
                return { success: false, message: "Ticket creation request has expired or is invalid." };
            }

            this.pendingTicketCreations.delete(confirmationId);

            if (!confirmed) {
                return { success: true, message: "Ticket creation has been cancelled." };
            }

            const ticketRepo = new TicketRepository(this.dataSource);
            const category = await ticketRepo.getTicketCategory(pendingCreation.categoryId);

            if (!category) {
                return { success: false, message: "The selected ticket category no longer exists." };
            }

            const guild = client.guilds.cache.get(pendingCreation.guildId);
            if (!guild) {
                return { success: false, message: "Server not found." };
            }

            const tempChannelName = `ticket-new`;
            const newTicketChannel = await guild.channels.create({
                name: tempChannelName,
                type: discord.ChannelType.GuildText,
                parent: category.categoryId,
                permissionOverwrites: [
                    {
                        id: guild.roles.everyone,
                        deny: [discord.PermissionFlagsBits.ViewChannel]
                    },
                    {
                        id: client.user!.id,
                        allow: [
                            discord.PermissionFlagsBits.ViewChannel,
                            discord.PermissionFlagsBits.SendMessages,
                            discord.PermissionFlagsBits.ManageChannels,
                            discord.PermissionFlagsBits.ReadMessageHistory
                        ]
                    },
                    {
                        id: pendingCreation.userId,
                        allow: [
                            discord.PermissionFlagsBits.ViewChannel,
                            discord.PermissionFlagsBits.SendMessages,
                            discord.PermissionFlagsBits.ReadMessageHistory
                        ]
                    }
                ]
            });

            const ticket = await ticketRepo.createTicket(
                pendingCreation.guildId,
                pendingCreation.userId,
                newTicketChannel.id,
                pendingCreation.categoryId
            );

            const channelName = `ticket-${ticket.ticketNumber.toString().padStart(4, '0')}`;
            await newTicketChannel.setName(channelName);

            if (category.supportRoleId) {
                try {
                    await newTicketChannel.permissionOverwrites.create(
                        category.supportRoleId,
                        {
                            ViewChannel: true,
                            SendMessages: true,
                            ReadMessageHistory: true
                        }
                    );
                } catch (permissionError) {
                    client.logger.warn(`[CHATBOT_SERVICE] Could not set permissions for support role: ${permissionError}`);
                }
            }

            const ticketMessage = category.ticketMessage;
            const welcomeMessage = ticketMessage?.welcomeMessage ||
                `Welcome to your ticket in the **${category.name}** category!\n\nOriginal question: *${pendingCreation.userMessage}*\n\nPlease provide any additional details, and a staff member will assist you shortly.`;

            const creationTimestamp = Math.floor(Date.now() / 1000);

            const welcomeEmbed = new discord.EmbedBuilder()
                .setTitle(`Ticket #${ticket.ticketNumber}`)
                .setDescription(welcomeMessage)
                .addFields(
                    { name: "Ticket ID", value: `#${ticket.ticketNumber}`, inline: true },
                    { name: "Category", value: `${category.emoji || "🎫"} ${category.name}`, inline: true },
                    { name: "Status", value: `🟢 Open`, inline: true },
                    { name: "Created By", value: `<@${pendingCreation.userId}>`, inline: true },
                    { name: "Created At", value: `<t:${creationTimestamp}:F>`, inline: true }
                )
                .setColor("Green")
                .setFooter({ text: `Use /ticket close to close this ticket | ID: ${ticket.id}` })
                .setTimestamp();

            const actionRow = new discord.ActionRowBuilder<discord.ButtonBuilder>()
                .addComponents(
                    new discord.ButtonBuilder()
                        .setCustomId("ticket_claim")
                        .setLabel("Claim Ticket")
                        .setStyle(discord.ButtonStyle.Primary)
                        .setEmoji("👋"),
                    new discord.ButtonBuilder()
                        .setCustomId("ticket_close")
                        .setLabel("Close Ticket")
                        .setStyle(discord.ButtonStyle.Danger)
                        .setEmoji("🔒")
                );

            await newTicketChannel.send({
                content: ticketMessage?.includeSupportTeam && category.supportRoleId ?
                    `<@${pendingCreation.userId}> | <@&${category.supportRoleId}>` :
                    `<@${pendingCreation.userId}>`,
                embeds: [welcomeEmbed],
                components: [actionRow]
            });

            client.logger.info(`[CHATBOT_SERVICE] Created ticket #${ticket.ticketNumber} via AI assistant for user ${pendingCreation.userId}`);

            return {
                success: true,
                message: `Ticket created successfully! Please check ${newTicketChannel} for further assistance.`,
                ticketChannel: newTicketChannel.toString()
            };

        } catch (error) {
            client.logger.error(`[CHATBOT_SERVICE] Error handling ticket confirmation: ${error}`);
            return { success: false, message: "An error occurred while creating the ticket." };
        }
    };

    /**
     * Clean up old pending confirmations (older than 5 minutes)
     */
    private cleanupOldConfirmations = (): void => {
        const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);

        for (const [key, value] of this.pendingTicketCreations.entries()) {
            const timestamp = parseInt(key.split('_').pop() || '0');
            if (timestamp < fiveMinutesAgo) {
                this.pendingTicketCreations.delete(key);
            }
        }
    };

    /**
     * Split long responses into Discord-friendly chunks
     * @param response - The response to split
     * @returns Array of response chunks
     */
    public splitResponse = (response: string): string[] => {
        const maxLength = 2000;
        const chunks: string[] = [];

        if (response.length <= maxLength) {
            return [response];
        }

        const paragraphs = response.split('\n\n');
        let currentChunk = '';

        for (const paragraph of paragraphs) {
            if ((currentChunk + paragraph).length > maxLength) {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                    currentChunk = '';
                }

                if (paragraph.length > maxLength) {
                    const sentences = paragraph.split('. ');
                    for (const sentence of sentences) {
                        if ((currentChunk + sentence + '. ').length > maxLength) {
                            if (currentChunk) {
                                chunks.push(currentChunk.trim());
                                currentChunk = '';
                            }
                            if (sentence.length > maxLength) {
                                const words = sentence.split(' ');
                                for (const word of words) {
                                    if ((currentChunk + word + ' ').length > maxLength) {
                                        if (currentChunk) {
                                            chunks.push(currentChunk.trim());
                                            currentChunk = '';
                                        }
                                    }
                                    currentChunk += word + ' ';
                                }
                            } else {
                                currentChunk = sentence + '. ';
                            }
                        } else {
                            currentChunk += sentence + '. ';
                        }
                    }
                } else {
                    currentChunk = paragraph + '\n\n';
                }
            } else {
                currentChunk += paragraph + '\n\n';
            }
        }

        if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
        }

        return chunks;
    };

    /**
     * Clear chat history for a user
     * @param userId - Discord user ID
     * @param guildId - Discord guild ID
     * @returns True if successful, false otherwise
     */
    public clearUserHistory = async (userId: string, guildId: string): Promise<boolean> => {
        try {
            const chatHistory = new ChatHistory(this.dataSource, userId, guildId);
            await chatHistory.clearHistory(false);
            return true;
        } catch (error) {
            client.logger.error(`[CHATBOT_SERVICE] Error clearing user history: ${error}`);
            return false;
        }
    };
}