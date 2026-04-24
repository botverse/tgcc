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
  userName?: string;
  userHandle?: string; // Telegram @username (without @)
  text: string;
  imageBase64?: string;
  imageMediaType?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  filePath?: string;
  fileName?: string;
  replyToText?: string;
  mediaGroupId?: string;
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
  { command: 'continue', description: 'Respawn process, keep session' },
  { command: 'sessions', description: 'List recent sessions' },
  { command: 'resume', description: 'Resume a session by ID' },
  { command: 'session', description: 'Current session info' },
  { command: 'status', description: 'Process state and session info' },
  { command: 'cost', description: 'Show session cost' },
  { command: 'catchup', description: 'Summarize external CC activity' },
  { command: 'restart', description: 'Restart the TGCC service' },
  { command: 'cancel', description: 'Abort current CC turn' },
  { command: 'compact', description: 'Compact conversation context' },
  { command: 'model', description: 'Switch model' },
  { command: 'permissions', description: 'Set permission mode' },
  { command: 'repo', description: 'Manage repos & switch working directory' },
  { command: 'cron', description: 'Manage scheduled cron jobs' },
  { command: 'ralph', description: 'Spawn shepherd to ensure task completion' },
  { command: 'new_cli', description: 'Open interactive CLI session via tmux' },
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

// ── Group member tracking ──

export interface GroupMember {
  userId: number;
  firstName: string;
  lastName?: string;
  handle?: string; // @username without the @
  isBot: boolean;
  role?: 'creator' | 'administrator' | 'member';
  lastSeen?: number; // epoch ms
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
  private rejectedKeys = new Set<string>(); // "userId:chatId" — tracks who already got rejection message
  private running = false;
  /** Per-chat group member roster: chatId → userId → GroupMember */
  private groupMembers = new Map<number, Map<number, GroupMember>>();

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

  private isAllowed(userId: number, chatId: number): boolean {
    // Open access: no users AND no chats configured
    if (this.config.allowedUsers.length === 0 && !this.config.allowedChats?.length) return true;
    // User-level allow (works for both DMs and groups)
    if (this.config.allowedUsers.includes(String(userId))) return true;
    // Chat-level allow (group/supergroup whose ID is in allowedChats)
    if (this.config.allowedChats?.includes(String(chatId))) return true;
    return false;
  }

  private async rejectUnauthorized(ctx: Context, userId: number, chatId: number): Promise<void> {
    const key = `${userId}:${chatId}`;
    if (this.rejectedKeys.has(key)) return; // silently ignore subsequent messages
    this.rejectedKeys.add(key);
    try {
      await ctx.reply("You're not authorized to use this bot. Contact the admin for access.", {
        reply_parameters: ctx.message ? { message_id: ctx.message.message_id } : undefined,
      });
    } catch (err) {
      this.logger.warn({ err, userId, chatId }, 'Failed to send rejection message');
    }
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

  /** Track a user seen in a group chat. Called on every group message. */
  trackGroupMember(ctx: Context): void {
    const chatId = ctx.chat?.id;
    const from = ctx.from;
    if (!chatId || chatId > 0 || !from) return; // only for group chats

    let members = this.groupMembers.get(chatId);
    if (!members) {
      members = new Map();
      this.groupMembers.set(chatId, members);
    }

    const existing = members.get(from.id);
    members.set(from.id, {
      userId: from.id,
      firstName: from.first_name,
      lastName: from.last_name,
      handle: from.username,
      isBot: from.is_bot,
      role: existing?.role,
      lastSeen: Date.now(),
    });
  }

  /** Bootstrap group roster by fetching admins from the TG API. */
  async fetchGroupAdmins(chatId: number): Promise<void> {
    try {
      const admins = await this.bot.api.getChatAdministrators(chatId);
      let members = this.groupMembers.get(chatId);
      if (!members) {
        members = new Map();
        this.groupMembers.set(chatId, members);
      }
      for (const admin of admins) {
        const existing = members.get(admin.user.id);
        members.set(admin.user.id, {
          userId: admin.user.id,
          firstName: admin.user.first_name,
          lastName: admin.user.last_name,
          handle: admin.user.username,
          isBot: admin.user.is_bot,
          role: admin.status as 'creator' | 'administrator',
          lastSeen: existing?.lastSeen,
        });
      }
      this.logger.debug({ chatId, count: admins.length }, 'Fetched group admins');
    } catch (err) {
      this.logger.warn({ err, chatId }, 'Failed to fetch group admins');
    }
  }

  /** Get formatted group roster for a chat. Returns null if no members tracked. */
  getGroupRoster(chatId: number): string | null {
    const members = this.groupMembers.get(chatId);
    if (!members || members.size === 0) return null;

    const lines: string[] = ['Group members:'];
    for (const m of members.values()) {
      if (m.isBot) continue; // skip bots from roster
      const name = m.lastName ? `${m.firstName} ${m.lastName}` : m.firstName;
      const handle = m.handle ? ` (@${m.handle})` : '';
      const role = m.role ? ` [${m.role}]` : '';
      lines.push(`- ${name}${handle}${role}`);
    }
    if (lines.length === 1) return null; // only header, no humans
    lines.push('\nUse @username mentions to address specific people.');
    return lines.join('\n');
  }

  private static getUserName(ctx: Context): string | undefined {
    const from = ctx.from;
    if (!from) return undefined;
    return from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name;
  }

  private setupHandlers(): void {
    // ── Group member tracking (runs before all handlers) ──
    this.bot.use((ctx, next) => {
      this.trackGroupMember(ctx);
      return next();
    });

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

  private async handleCallbackQuery(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;
    if (!this.isAllowed(userId, chatId)) {
      const key = `${userId}:${chatId}`;
      if (!this.rejectedKeys.has(key)) {
        this.rejectedKeys.add(key);
        try { await ctx.answerCallbackQuery({ text: 'Not authorized.', show_alert: true }); } catch {}
      }
      return;
    }
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

  private async handleCommand(ctx: Context, command: string): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;
    if (!this.isAllowed(userId, chatId)) { await this.rejectUnauthorized(ctx, userId, chatId); return; }

    const text = ctx.message?.text ?? '';
    // Strip entire first token (/command or /command@BotName) for group compatibility
    const args = text.replace(/^\/\S+\s*/, '').trim();

    this.onCommand({
      command,
      args,
      chatId,
      userId: String(userId),
    });
  }

  private async handleText(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;
    if (!this.isAllowed(userId, chatId)) { await this.rejectUnauthorized(ctx, userId, chatId); return; }
    if (!ctx.message?.text) return;

    // Skip if it's a command (already handled)
    if (ctx.message.text.startsWith('/')) return;

    // Check for message interceptors (e.g. auth flow waiting for code)
    if (this.tryIntercept(chatId, ctx.message.text.trim())) return;

    // Check for reply context
    let replyToText: string | undefined;
    if (ctx.message.reply_to_message?.message_id) {
      replyToText = this.getReplyMap(chatId).get(ctx.message.reply_to_message.message_id);
    }

    this.onMessage({
      type: 'text',
      chatId,
      userId: String(userId),
      userName: TelegramBot.getUserName(ctx),
      userHandle: ctx.from?.username,
      text: ctx.message.text,
      replyToText,
    });
  }

  private async handlePhoto(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;
    if (!this.isAllowed(userId, chatId)) { await this.rejectUnauthorized(ctx, userId, chatId); return; }

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
      const caption = ctx.message?.caption ?? '';

      this.onMessage({
        type: 'photo',
        chatId,
        userId: String(userId),
        userName: TelegramBot.getUserName(ctx),
        userHandle: ctx.from?.username,
        text: caption,
        imageBase64: base64,
        imageMediaType: mediaType,
        mediaGroupId: ctx.message?.media_group_id,
      });
    } catch (err) {
      this.logger.error({ err }, 'Failed to handle photo');
    }
  }

  private async handleDocument(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;
    if (!this.isAllowed(userId, chatId)) { await this.rejectUnauthorized(ctx, userId, chatId); return; }

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
      const userName = TelegramBot.getUserName(ctx);
      const userHandle = ctx.from?.username;

      // Check if it's an image — send as image content block
      if (doc.mime_type?.startsWith('image/')) {
        const base64 = buffer.toString('base64');
        const mediaType = detectImageMediaType(fileName);
        this.onMessage({
          type: 'photo',
          chatId,
          userId: String(userId),
          userName,
          userHandle,
          text: caption,
          imageBase64: base64,
          imageMediaType: mediaType,
        });
        return;
      }

      this.onMessage({
        type: 'document',
        chatId,
        userId: String(userId),
        userName,
        userHandle,
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
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;
    if (!this.isAllowed(userId, chatId)) { await this.rejectUnauthorized(ctx, userId, chatId); return; }

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
        chatId,
        userId: String(userId),
        userName: TelegramBot.getUserName(ctx),
        userHandle: ctx.from?.username,
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
    const chatId = ctx.chat?.id;
    if (!userId || !chatId) return;
    if (!this.isAllowed(userId, chatId)) { await this.rejectUnauthorized(ctx, userId, chatId); return; }

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
        chatId,
        userId: String(userId),
        userName: TelegramBot.getUserName(ctx),
        userHandle: ctx.from?.username,
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

    // Bootstrap group member roster from admin list
    if (this.config.allowedChats?.length) {
      for (const chatIdStr of this.config.allowedChats) {
        const chatId = Number(chatIdStr);
        if (chatId < 0) {
          this.fetchGroupAdmins(chatId).catch(() => {}); // fire & forget
        }
      }
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

  /** Update config at runtime (e.g. after hot-reload). Clears rejection cache and bootstraps new group rosters. */
  updateConfig(newConfig: AgentConfig): void {
    const oldChats = new Set(this.config.allowedChats ?? []);
    this.config = newConfig;
    // Auth rules changed — clear rejection cache so previously-rejected users get re-evaluated
    this.rejectedKeys.clear();
    this.logger.info('Config updated — rejectedKeys cleared');
    // Bootstrap group roster for any newly-added allowedChats
    for (const chatIdStr of newConfig.allowedChats ?? []) {
      if (!oldChats.has(chatIdStr)) {
        const chatId = Number(chatIdStr);
        if (chatId < 0) {
          this.fetchGroupAdmins(chatId).catch(() => {});
        }
      }
    }
  }

  async stop(): Promise<void> {
    if (this.running) {
      this.running = false;
      this.bot.stop();
      this.replyMaps.clear();
      this.rejectedKeys.clear();
      this.logger.info('Bot stopped');
    }
  }

  // ── Send methods (used by bridge/streaming) ──

  /** Skip Telegram API calls for synthetic chatId 0 (supervisor-initiated messages). */
  private isSyntheticChat(chatId: number | string): boolean {
    return Number(chatId) === 0;
  }

  async sendText(chatId: number | string, text: string, parseMode?: string, silent = false): Promise<number> {
    if (this.isSyntheticChat(chatId)) return 0;
    const msg = await this.bot.api.sendMessage(Number(chatId), text, {
      parse_mode: parseMode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined,
      disable_notification: silent || undefined,
    });
    this.trackBotMessage(Number(chatId), msg.message_id, text);
    return msg.message_id;
  }

  async sendTextWithKeyboard(chatId: number | string, text: string, keyboard: InlineKeyboard, parseMode?: string): Promise<number> {
    if (this.isSyntheticChat(chatId)) return 0;
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
    if (this.isSyntheticChat(chatId)) return;
    await this.bot.api.editMessageText(Number(chatId), messageId, text, {
      parse_mode: parseMode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined,
    });
    this.trackBotMessage(Number(chatId), messageId, text);
  }

  async editTextWithKeyboard(chatId: number | string, messageId: number, text: string, keyboard: InlineKeyboard, parseMode?: string): Promise<void> {
    if (this.isSyntheticChat(chatId)) return;
    await this.bot.api.editMessageText(Number(chatId), messageId, text, {
      parse_mode: parseMode as 'Markdown' | 'MarkdownV2' | 'HTML' | undefined,
      reply_markup: keyboard,
    });
    this.trackBotMessage(Number(chatId), messageId, text);
  }

  async setReaction(chatId: number | string, messageId: number, emoji: string): Promise<void> {
    // Cast needed because Grammy's emoji type is a fixed union
    await this.bot.api.setMessageReaction(Number(chatId), messageId, [{ type: 'emoji', emoji: emoji as '👍' }]);
  }

  async deleteMessage(chatId: number | string, messageId: number): Promise<void> {
    await this.bot.api.deleteMessage(Number(chatId), messageId);
  }

  async sendFile(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath), {
      caption,
    });
  }

  async sendDocumentBuffer(chatId: number | string, buffer: Buffer, filename: string, caption?: string): Promise<number> {
    if (this.isSyntheticChat(chatId)) return 0;
    const msg = await this.bot.api.sendDocument(Number(chatId), new InputFile(buffer, filename), {
      caption,
    });
    return msg.message_id;
  }

  async sendImage(chatId: number | string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(Number(chatId), new InputFile(filePath), {
      caption,
    });
  }

  async sendPhotoBuffer(chatId: number | string, buffer: Buffer, caption?: string): Promise<number> {
    if (this.isSyntheticChat(chatId)) return 0;
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
    if (this.isSyntheticChat(chatId)) return;
    try {
      await this.bot.api.sendChatAction(Number(chatId), 'typing');
    } catch {}
  }

  // ── Message interception (for auth flow) ──

  private messageInterceptors = new Map<number, (text: string) => boolean>(); // chatId → handler (returns true to consume)

  /**
   * Register a one-shot interceptor that consumes the next non-command text message from a chat.
   * Returns the message text, or null on timeout.
   */
  waitForMessage(chatId: number, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.messageInterceptors.delete(chatId);
        resolve(null);
      }, timeoutMs);

      this.messageInterceptors.set(chatId, (text: string) => {
        clearTimeout(timer);
        this.messageInterceptors.delete(chatId);
        resolve(text);
        return true; // consumed
      });
    });
  }

  /**
   * Try to intercept a message. Returns true if the message was consumed by an interceptor.
   * Called from handleText before normal message processing.
   */
  tryIntercept(chatId: number, text: string): boolean {
    const handler = this.messageInterceptors.get(chatId);
    if (handler) return handler(text);
    return false;
  }
}
