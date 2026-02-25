import { Bot, InlineKeyboard, InputFile, type Context } from 'grammy';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import type pino from 'pino';
import type { AgentConfig } from './config.js';

// ── Types ──

export interface TelegramMessage {
  type: 'text' | 'photo' | 'document' | 'voice' | 'video';
  chatId: number;
  userId: string;
  text: string;
  imageBase64?: string;
  imageMediaType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  filePath?: string;
  fileName?: string;
  replyToText?: string;
}

export interface SlashCommand {
  command: string;
  args: string;
  chatId: number;
  userId: string;
}

export interface CallbackQuery {
  action: string;
  data: string;
  chatId: number;
  userId: string;
  callbackQueryId: string;
}

export type MessageHandler = (msg: TelegramMessage) => void;
export type CommandHandler = (cmd: SlashCommand) => void;
export type CallbackHandler = (query: CallbackQuery) => void;

// ── Slash command definitions ──

export const COMMANDS = [
  { command: 'start', description: 'Welcome message & register commands' },
  { command: 'new', description: 'Start a fresh session' },
  { command: 'sessions', description: 'List recent sessions' },
  { command: 'resume', description: 'Resume a session by ID' },
  { command: 'session', description: 'Current session info' },
  { command: 'status', description: 'Process state and session info' },
  { command: 'cost', description: 'Show session cost' },
  { command: 'catchup', description: 'Summarize external CC activity' },
  { command: 'cancel', description: 'Abort current CC turn' },
  { command: 'model', description: 'Switch model' },
  { command: 'permissions', description: 'Set permission mode' },
  { command: 'repo', description: 'Manage repos & switch working directory' },
  { command: 'ping', description: 'Quick liveness check' },
  { command: 'help', description: 'List all commands' },
];

// ── Media type detection ──

function detectImageMediaType(fileName: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const ext = extname(fileName).toLowerCase();
  switch (ext) {
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'image/jpeg';
  }
}

// ── Reply message map (for reply context) ──

const MESSAGE_MAP_SIZE = 50;

class ReplyMap {
  private entries: Array<{ messageId: number; text: string }> = [];

  add(messageId: number, text: string): void {
    this.entries.push({ messageId, text: text.slice(0, 200) });
    if (this.entries.length > MESSAGE_MAP_SIZE) {
      this.entries.shift();
    }
  }

  get(messageId: number): string | undefined {
    return this.entries.find(e => e.messageId === messageId)?.text;
  }
}

// ── Telegram Agent Bot ──

export class TelegramBot {
  readonly agentId: string;
  readonly bot: Bot;
  private config: AgentConfig;
  private logger: pino.Logger;
  private mediaDir: string;
  private onMessage: MessageHandler;
  private onCommand: CommandHandler;
  private onCallback: CallbackHandler | null;
  private replyMaps = new Map<number, ReplyMap>(); // per-chat reply maps
  private running = false;

  constructor(
    agentId: string,
    config: AgentConfig,
    mediaDir: string,
    onMessage: MessageHandler,
    onCommand: CommandHandler,
    logger: pino.Logger,
    onCallback?: CallbackHandler,
  ) {
    this.agentId = agentId;
    this.config = config;
    this.mediaDir = mediaDir;
    this.logger = logger.child({ agentId, component: 'telegram' });
    this.onMessage = onMessage;
    this.onCommand = onCommand;
    this.onCallback = onCallback ?? null;

    this.bot = new Bot(config.botToken);
    this.setupHandlers();
  }

  private isAllowed(userId: number): boolean {
    // Empty allowedUsers = open access (anyone can use the bot)
    if (this.config.allowedUsers.length === 0) return true;
    return this.config.allowedUsers.includes(String(userId));
  }

  private getReplyMap(chatId: number): ReplyMap {
    let map = this.replyMaps.get(chatId);
    if (!map) {
      map = new ReplyMap();
      this.replyMaps.set(chatId, map);
    }
    return map;
  }

  trackBotMessage(chatId: number, messageId: number, text: string): void {
    this.getReplyMap(chatId).add(messageId, text);
  }

  private setupHandlers(): void {
    // ── Slash commands ──
    for (const { command } of COMMANDS) {
      this.bot.command(command, (ctx) => this.handleCommand(ctx, command));
    }

    // ── Callback queries (inline button presses) ──
    this.bot.on('callback_query:data', (ctx) => this.handleCallbackQuery(ctx));

    // ── Text messages ──
    this.bot.on('message:text', (ctx) => this.handleText(ctx));

    // ── Photos ──
    this.bot.on('message:photo', (ctx) => this.handlePhoto(ctx));

    // ── Documents ──
    this.bot.on('message:document', (ctx) => this.handleDocument(ctx));

    // ── Voice ──
    this.bot.on('message:voice', (ctx) => this.handleVoice(ctx));

    // ── Video ──
    this.bot.on('message:video', (ctx) => this.handleVideo(ctx));
  }

  private handleCallbackQuery(ctx: Context): void {
    const userId = ctx.from?.id;
    if (!userId || !this.isAllowed(userId)) return;
    if (!ctx.callbackQuery?.data) return;
    if (!this.onCallback) return;

    const data = ctx.callbackQuery.data;
    const colonIdx = data.indexOf(':');
    if (colonIdx === -1) return;

    const action = data.slice(0, colonIdx);
    const payload = data.slice(colonIdx + 1);

    this.onCallback({
      action,
      data: payload,
      chatId: ctx.chat!.id,
      userId: String(userId),
      callbackQueryId: ctx.callbackQuery.id,
    });
  }

  private handleCommand(ctx: Context, command: string): void {
    const userId = ctx.from?.id;
    if (!userId || !this.isAllowed(userId)) return;

    const text = ctx.message?.text ?? '';
    const args = text.replace(`/${command}`, '').trim();

    this.onCommand({
      command,
      args,
      chatId: ctx.chat!.id,
      userId: String(userId),
    });
  }

  private handleText(ctx: Context): void {
    const userId = ctx.from?.id;
    if (!userId || !this.isAllowed(userId)) return;
    if (!ctx.message?.text) return;

    // Skip if it's a command (already handled)
    if (ctx.message.text.startsWith('/')) return;

    // Check for reply context
    let replyToText: string | undefined;
    if (ctx.message.reply_to_message?.message_id) {
      replyToText = this.getReplyMap(ctx.chat!.id).get(ctx.message.reply_to_message.message_id);
    }

    this.onMessage({
      type: 'text',
      chatId: ctx.chat!.id,
      userId: String(userId),
      text: ctx.message.text,
      replyToText,
    });
  }

  private async handlePhoto(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAllowed(userId)) return;

    try {
      // Get the largest photo
      const photos = ctx.message?.photo;
      if (!photos || photos.length === 0) return;

      const largest = photos[photos.length - 1];
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

      // Download and convert to base64
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const base64 = buffer.toString('base64');

      const mediaType = detectImageMediaType(file.file_path ?? 'photo.jpg');
      const caption = ctx.message?.caption ?? 'What do you see in this image?';

      this.onMessage({
        type: 'photo',
        chatId: ctx.chat!.id,
        userId: String(userId),
        text: caption,
        imageBase64: base64,
        imageMediaType: mediaType,
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to handle photo');
    }
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAllowed(userId)) return;

    try {
      const doc = ctx.message?.document;
      if (!doc) return;

      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

      // Download to disk
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const fileName = doc.file_name ?? `doc_${Date.now()}`;
      const savePath = join(this.mediaDir, fileName);

      if (!existsSync(this.mediaDir)) mkdirSync(this.mediaDir, { recursive: true });
      writeFileSync(savePath, buffer);

      const caption = ctx.message?.caption ?? '';

      // Check if it's an image — send as image content block
      if (doc.mime_type?.startsWith('image/')) {
        const base64 = buffer.toString('base64');
        const mediaType = detectImageMediaType(fileName);
        this.onMessage({
          type: 'photo',
          chatId: ctx.chat!.id,
          userId: String(userId),
          text: caption || 'What do you see in this image?',
          imageBase64: base64,
          imageMediaType: mediaType,
        });
        return;
      }

      this.onMessage({
        type: 'document',
        chatId: ctx.chat!.id,
        userId: String(userId),
        text: caption,
        filePath: savePath,
        fileName,
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to handle document');
    }
  }

  private async handleVoice(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAllowed(userId)) return;

    try {
      const voice = ctx.message?.voice;
      if (!voice) return;

      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const fileName = `voice_${Date.now()}.ogg`;
      const savePath = join(this.mediaDir, fileName);

      if (!existsSync(this.mediaDir)) mkdirSync(this.mediaDir, { recursive: true });
      writeFileSync(savePath, buffer);

      this.onMessage({
        type: 'voice',
        chatId: ctx.chat!.id,
        userId: String(userId),
        text: ctx.message?.caption ?? '',
        filePath: savePath,
        fileName,
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to handle voice');
    }
  }

  private async handleVideo(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId || !this.isAllowed(userId)) return;

    try {
      const video = ctx.message?.video;
      if (!video) return;

      const file = await ctx.api.getFile(video.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      const fileName = video.file_name ?? `video_${Date.now()}.mp4`;
      const savePath = join(this.mediaDir, fileName);

      if (!existsSync(this.mediaDir)) mkdirSync(this.mediaDir, { recursive: true });
      writeFileSync(savePath, buffer);

      this.onMessage({
        type: 'video',
        chatId: ctx.chat!.id,
        userId: String(userId),
        text: ctx.message?.caption ?? '',
        filePath: savePath,
        fileName,
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to handle video');
    }
  }

  // ── Bot lifecycle ──

  async start(): Promise<void> {
    // Register commands with BotFather
    try {
      await this.bot.api.setMyCommands(COMMANDS);
      this.logger.info('Registered slash commands with BotFather');
    } catch (err) {
      this.logger.warn({ err }, 'Failed to register commands');
    }

    this.running = true;
    this.bot.start({
      drop_pending_updates: true,
      timeout: 30, // 30 second timeout for getUpdates
      onStart: (info) => {
        this.logger.info({ username: info.username }, 'Bot started');
      },
    });
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.running = false;
      this.bot.stop();
      this.replyMaps.clear();
      this.logger.info('Bot stopped');
    }
  }

  // ── Send methods (used by bridge/streaming) ──

  async sendText(chatId: number | string, text: string, parseMode?: string): Promise<number> {
    const msg = await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: parseMode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined,
    });
    this.trackBotMessage(Number(chatId), msg.message_id, text);
    return msg.message_id;
  }

  async sendTextWithKeyboard(chatId: number | string, text: string, keyboard: InlineKeyboard, parseMode?: string): Promise<number> {
    const msg = await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: parseMode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined,
      reply_markup: keyboard,
    });
    this.trackBotMessage(Number(chatId), msg.message_id, text);
    return msg.message_id;
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(callbackQueryId, { text });
  }

  async editText(chatId: number | string, messageId: number, text: string, parseMode?: string): Promise<void> {
    await this.bot.api.editMessageText(Number(chatId), messageId, text, {
      parse_mode: parseMode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined,
    });
    this.trackBotMessage(Number(chatId), messageId, text);
  }

  async setReaction(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    // Cast needed because Grammy's emoji type is a fixed union
    await this.bot.api.setMessageReaction(Number(chatId), messageId, [{ type: 'emoji', emoji: emoji as '👍' }]);
  }

  async sendFile(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath), {
      caption,
    });
  }

  async sendImage(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(Number(chatId), new InputFile(filePath), {
      caption,
    });
  }

  async sendPhotoBuffer(chatId: number | string, buffer: Buffer, caption?: string): Promise<number> {
    const msg = await this.bot.api.sendPhoto(Number(chatId), new InputFile(buffer, 'image.png'), {
      caption,
    });
    return msg.message_id;
  }

  async sendVoice(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendVoice(Number(chatId), new InputFile(filePath), {
      caption,
    });
  }

  async replyToMessage(chatId: number | string, text: string, replyToMessageId: number, parseMode?: string): Promise<number> {
    const msg = await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: parseMode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined,
      reply_parameters: { message_id: replyToMessageId },
    });
    this.trackBotMessage(Number(chatId), msg.message_id, text);
    return msg.message_id;
  }

  async sendTyping(chatId: number | string): Promise<void> {
    try {
      await this.bot.api.sendChatAction(Number(chatId), 'typing');
    } catch {}
  }
}
