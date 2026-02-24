import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type {
  TgccConfig,
  AgentConfig,
  ConfigDiff,
} from './config.js';
import { resolveUserConfig, resolveRepoPath } from './config.js';
import { CCProcess, generateMcpConfig } from './cc-process.js';
import {
  createTextMessage,
  createImageMessage,
  createDocumentMessage,
  extractAssistantText,
  type InitEvent,
  type AssistantMessage,
  type ResultEvent,
  type StreamInnerEvent,
} from './cc-protocol.js';
import { StreamAccumulator, splitText, type TelegramSender } from './streaming.js';
import { TelegramBot, type TelegramMessage, type SlashCommand, type CallbackQuery } from './telegram.js';
import { InlineKeyboard } from 'grammy';
import { McpBridgeServer, type McpToolRequest, type McpToolResponse } from './mcp-bridge.js';
import {
  SessionStore,
  findMissedSessions,
  formatCatchupMessage,
} from './session.js';

// ── Types ──

interface AgentInstance {
  id: string;
  config: AgentConfig;
  tgBot: TelegramBot;
  processes: Map<string, CCProcess>;       // userId → CCProcess
  accumulators: Map<string, StreamAccumulator>; // `${userId}:${chatId}` → accumulator
  batchers: Map<string, MessageBatcher>;   // userId → batcher
  pendingTitles: Map<string, string>;      // userId → first message text for session title
}

// ── Message Batcher ──

class MessageBatcher {
  private pending: Array<{ text: string; imageBase64?: string; imageMediaType?: string; filePath?: string; fileName?: string }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private flush: (combined: { text: string; imageBase64?: string; imageMediaType?: string; filePath?: string; fileName?: string }) => void;

  constructor(windowMs: number, flushFn: typeof MessageBatcher.prototype.flush) {
    this.windowMs = windowMs;
    this.flush = flushFn;
  }

  add(msg: { text: string; imageBase64?: string; imageMediaType?: string; filePath?: string; fileName?: string }): void {
    this.pending.push(msg);

    // If this is a media message, flush immediately (don't batch media)
    if (msg.imageBase64 || msg.filePath) {
      this.doFlush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.doFlush(), this.windowMs);
    }
  }

  private doFlush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.pending.length === 0) return;

    // If there's a single message with media, send it directly
    if (this.pending.length === 1) {
      this.flush(this.pending[0]);
      this.pending = [];
      return;
    }

    // Combine text-only messages
    const combined = this.pending.map(m => m.text).filter(Boolean).join('\n\n');
    this.flush({ text: combined });
    this.pending = [];
  }

  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = [];
  }
}

// ── Help text ──

const HELP_TEXT = `*TGCC Commands*

*Session*
/new — Start a fresh session
/sessions — List recent sessions
/resume <id> — Resume a session by ID
/session — Current session info

*Info*
/status — Process state, model, uptime
/cost — Show session cost
/catchup — Summarize external CC activity
/ping — Liveness check

*Control*
/cancel — Abort current CC turn
/model <name> — Switch model
/repo <path> — Switch working directory

/help — This message`;

// ── Bridge ──

export class Bridge extends EventEmitter {
  private config: TgccConfig;
  private agents = new Map<string, AgentInstance>();
  private mcpServer: McpBridgeServer;
  private sessionStore: SessionStore;
  private logger: pino.Logger;

  constructor(config: TgccConfig, logger?: pino.Logger) {
    super();
    this.config = config;
    this.logger = logger ?? pino({ level: config.global.logLevel });
    this.sessionStore = new SessionStore(config.global.stateFile, this.logger);
    this.mcpServer = new McpBridgeServer(
      (req) => this.handleMcpToolRequest(req),
      this.logger,
    );
  }

  // ── Startup ──

  async start(): Promise<void> {
    this.logger.info('Starting bridge');

    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      await this.startAgent(agentId, agentConfig);
    }

    this.logger.info({ agents: Object.keys(this.config.agents) }, 'Bridge started');
  }

  private async startAgent(agentId: string, agentConfig: AgentConfig): Promise<void> {
    this.logger.info({ agentId }, 'Starting agent');

    const tgBot = new TelegramBot(
      agentId,
      agentConfig,
      this.config.global.mediaDir,
      (msg) => this.handleTelegramMessage(agentId, msg),
      (cmd) => this.handleSlashCommand(agentId, cmd),
      this.logger,
      (query) => this.handleCallbackQuery(agentId, query),
    );

    const instance: AgentInstance = {
      id: agentId,
      config: agentConfig,
      tgBot,
      processes: new Map(),
      accumulators: new Map(),
      batchers: new Map(),
      pendingTitles: new Map(),
    };

    this.agents.set(agentId, instance);
    await tgBot.start();
  }

  // ── Hot reload ──

  async handleConfigChange(newConfig: TgccConfig, diff: ConfigDiff): Promise<void> {
    this.logger.info({ diff }, 'Handling config change');

    // Remove agents
    for (const agentId of diff.removed) {
      await this.stopAgent(agentId);
    }

    // Add new agents
    for (const agentId of diff.added) {
      await this.startAgent(agentId, newConfig.agents[agentId]);
    }

    // Handle changed agents
    for (const agentId of diff.changed) {
      const oldAgent = this.agents.get(agentId);
      const newAgentConfig = newConfig.agents[agentId];

      if (!oldAgent) continue;

      // If bot token changed, full restart
      if (oldAgent.config.botToken !== newAgentConfig.botToken) {
        await this.stopAgent(agentId);
        await this.startAgent(agentId, newAgentConfig);
      } else {
        // Update in-memory config — active processes keep old config
        oldAgent.config = newAgentConfig;
      }
    }

    this.config = newConfig;
  }

  private async stopAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.logger.info({ agentId }, 'Stopping agent');

    // Stop bot
    await agent.tgBot.stop();

    // Kill all CC processes
    for (const [, proc] of agent.processes) {
      proc.destroy();
    }

    // Cancel batchers
    for (const [, batcher] of agent.batchers) {
      batcher.cancel();
    }

    // Close MCP sockets
    for (const userId of agent.processes.keys()) {
      const socketPath = join(this.config.global.socketDir, `${agentId}-${userId}.sock`);
      this.mcpServer.close(socketPath);
    }

    this.agents.delete(agentId);
  }

  // ── Message handling ──

  private handleTelegramMessage(agentId: string, msg: TelegramMessage): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.logger.debug({ agentId, userId: msg.userId, type: msg.type }, 'TG message received');

    // Ensure batcher exists
    if (!agent.batchers.has(msg.userId)) {
      agent.batchers.set(msg.userId, new MessageBatcher(2000, (combined) => {
        this.sendToCC(agentId, msg.userId, msg.chatId, combined);
      }));
    }

    // Prepare text with reply context
    let text = msg.text;
    if (msg.replyToText) {
      text = `[Replying to: '${msg.replyToText}']\n\n${text}`;
    }

    const batcher = agent.batchers.get(msg.userId)!;
    batcher.add({
      text,
      imageBase64: msg.imageBase64,
      imageMediaType: msg.imageMediaType,
      filePath: msg.filePath,
      fileName: msg.fileName,
    });
  }

  private sendToCC(
    agentId: string,
    userId: string,
    chatId: number,
    data: { text: string; imageBase64?: string; imageMediaType?: string; filePath?: string; fileName?: string }
  ): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Construct CC message
    let ccMsg;
    if (data.imageBase64) {
      ccMsg = createImageMessage(
        data.text || 'What do you see in this image?',
        data.imageBase64,
        data.imageMediaType as 'image/jpeg' | undefined,
      );
    } else if (data.filePath && data.fileName) {
      ccMsg = createDocumentMessage(data.text, data.filePath, data.fileName);
    } else {
      ccMsg = createTextMessage(data.text);
    }

    // Get or create CC process
    let proc = agent.processes.get(userId);
    if (!proc || proc.state === 'idle') {
      // Save first message text as pending session title
      if (data.text) {
        agent.pendingTitles.set(userId, data.text);
      }
      proc = this.spawnCCProcess(agentId, userId, chatId);
      agent.processes.set(userId, proc);
    }

    // Show typing indicator
    agent.tgBot.sendTyping(chatId);

    proc.sendMessage(ccMsg);
    this.sessionStore.updateSessionActivity(agentId, userId);
  }

  private spawnCCProcess(agentId: string, userId: string, chatId: number): CCProcess {
    const agent = this.agents.get(agentId)!;
    const userConfig = resolveUserConfig(agent.config, userId);

    // Check session store for model/repo overrides
    const userState = this.sessionStore.getUser(agentId, userId);
    if (userState.model) userConfig.model = userState.model;
    if (userState.repo) userConfig.repo = userState.repo;

    // Generate MCP config
    const mcpServerPath = join(import.meta.dirname ?? '.', 'mcp-server.js');
    const mcpConfigPath = generateMcpConfig(
      agentId,
      userId,
      this.config.global.socketDir,
      mcpServerPath,
    );

    // Start MCP socket listener for this agent-user pair
    const socketPath = join(this.config.global.socketDir, `${agentId}-${userId}.sock`);
    this.mcpServer.listen(socketPath);

    const proc = new CCProcess({
      agentId,
      userId,
      ccBinaryPath: this.config.global.ccBinaryPath,
      userConfig,
      mcpConfigPath,
      sessionId: userState.currentSessionId ?? undefined,
      continueSession: !!userState.currentSessionId,
      logger: this.logger,
    });

    // ── Wire up event handlers ──

    proc.on('init', (event: InitEvent) => {
      this.sessionStore.setCurrentSession(agentId, userId, event.session_id);
      // Set session title from the first user message
      const pendingTitle = agent.pendingTitles.get(userId);
      if (pendingTitle) {
        this.sessionStore.setSessionTitle(agentId, userId, event.session_id, pendingTitle);
        agent.pendingTitles.delete(userId);
      }
    });

    proc.on('stream_event', (event: StreamInnerEvent) => {
      this.handleStreamEvent(agentId, userId, chatId, event);
    });

    proc.on('assistant', (event: AssistantMessage) => {
      // Non-streaming fallback — only used if stream_events don't fire
      // In practice, stream_events handle the display
    });

    proc.on('result', (event: ResultEvent) => {
      this.handleResult(agentId, userId, chatId, event);
    });

    proc.on('hang', () => {
      agent.tgBot.sendText(chatId, '_CC session paused. Send a message to continue._', 'Markdown');
    });

    proc.on('exit', () => {
      // Finalize any active accumulator
      const accKey = `${userId}:${chatId}`;
      const acc = agent.accumulators.get(accKey);
      if (acc) {
        acc.finalize();
        agent.accumulators.delete(accKey);
      }
    });

    proc.on('error', (err: Error) => {
      agent.tgBot.sendText(chatId, `_CC error: ${err.message}_`, 'Markdown');
    });

    return proc;
  }

  // ── Stream event handling ──

  private handleStreamEvent(agentId: string, userId: string, chatId: number, event: StreamInnerEvent): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const accKey = `${userId}:${chatId}`;
    let acc = agent.accumulators.get(accKey);

    if (!acc) {
      const sender: TelegramSender = {
        sendMessage: (cid, text, parseMode) => agent.tgBot.sendText(cid, text, parseMode),
        editMessage: (cid, msgId, text, parseMode) => agent.tgBot.editText(cid, msgId, text, parseMode),
      };
      acc = new StreamAccumulator({ chatId, sender });
      agent.accumulators.set(accKey, acc);
    }

    acc.handleEvent(event);
  }

  private handleResult(agentId: string, userId: string, chatId: number, event: ResultEvent): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Finalize accumulator
    const accKey = `${userId}:${chatId}`;
    const acc = agent.accumulators.get(accKey);
    if (acc) {
      acc.finalize();
      agent.accumulators.delete(accKey);
    }

    // Update session store with cost
    if (event.total_cost_usd) {
      this.sessionStore.updateSessionActivity(agentId, userId, event.total_cost_usd);
    }

    // Handle errors
    if (event.is_error && event.result) {
      agent.tgBot.sendText(chatId, `_Error: ${event.result}_`, 'Markdown');
    }
  }

  // ── Slash commands ──

  private async handleSlashCommand(agentId: string, cmd: SlashCommand): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.logger.debug({ agentId, command: cmd.command, args: cmd.args }, 'Slash command');

    switch (cmd.command) {
      case 'help':
        await agent.tgBot.sendText(cmd.chatId, HELP_TEXT, 'Markdown');
        break;

      case 'ping': {
        const proc = agent.processes.get(cmd.userId);
        const state = proc?.state ?? 'idle';
        await agent.tgBot.sendText(cmd.chatId, `pong — process: ${state.toUpperCase()}`);
        break;
      }

      case 'status': {
        const proc = agent.processes.get(cmd.userId);
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const uptime = proc?.spawnedAt
          ? formatDuration(Date.now() - proc.spawnedAt.getTime())
          : 'N/A';

        const status = [
          `*Agent:* ${agentId}`,
          `*Process:* ${(proc?.state ?? 'idle').toUpperCase()} (uptime: ${uptime})`,
          `*Session:* \`${proc?.sessionId?.slice(0, 8) ?? 'none'}\``,
          `*Model:* ${userState.model || resolveUserConfig(agent.config, cmd.userId).model}`,
          `*Repo:* ${userState.repo || resolveUserConfig(agent.config, cmd.userId).repo}`,
          `*Cost:* $${(proc?.totalCostUsd ?? 0).toFixed(4)}`,
        ].join('\n');
        await agent.tgBot.sendText(cmd.chatId, status, 'Markdown');
        break;
      }

      case 'cost': {
        const proc = agent.processes.get(cmd.userId);
        await agent.tgBot.sendText(cmd.chatId, `Session cost: $${(proc?.totalCostUsd ?? 0).toFixed(4)}`);
        break;
      }

      case 'new': {
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        this.sessionStore.clearSession(agentId, cmd.userId);
        await agent.tgBot.sendText(cmd.chatId, 'Session cleared. Next message starts fresh.');
        break;
      }

      case 'sessions': {
        const sessions = this.sessionStore.getRecentSessions(agentId, cmd.userId);
        if (sessions.length === 0) {
          await agent.tgBot.sendText(cmd.chatId, 'No recent sessions.');
          break;
        }
        const currentSessionId = this.sessionStore.getUser(agentId, cmd.userId).currentSessionId;

        const lines: string[] = [];
        const keyboard = new InlineKeyboard();

        sessions.forEach((s, i) => {
          const title = s.title ? `"${s.title}"` : `\`${s.id.slice(0, 8)}\``;
          const age = formatAge(new Date(s.lastActivity));
          const isCurrent = s.id === currentSessionId;
          lines.push(`${i + 1}. ${title} — ${s.messageCount} msgs, $${s.totalCostUsd.toFixed(2)} (${age})${isCurrent ? ' ✓' : ''}`);

          if (!isCurrent) {
            keyboard.text('Resume', `resume:${s.id}`);
          }
          keyboard.text('Delete', `delete:${s.id}`).row();
        });

        await agent.tgBot.sendTextWithKeyboard(
          cmd.chatId,
          `📋 *Recent sessions:*\n\n${lines.join('\n')}`,
          keyboard,
          'Markdown',
        );
        break;
      }

      case 'resume': {
        if (!cmd.args) {
          await agent.tgBot.sendText(cmd.chatId, 'Usage: /resume <session-id>');
          break;
        }
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        this.sessionStore.setCurrentSession(agentId, cmd.userId, cmd.args.trim());
        await agent.tgBot.sendText(cmd.chatId, `Will resume session \`${cmd.args.trim().slice(0, 8)}\` on next message.`, 'Markdown');
        break;
      }

      case 'session': {
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const session = userState.sessions.find(s => s.id === userState.currentSessionId);
        if (!session) {
          await agent.tgBot.sendText(cmd.chatId, 'No active session.');
          break;
        }
        await agent.tgBot.sendText(cmd.chatId,
          `*Session:* \`${session.id.slice(0, 8)}\`\n*Messages:* ${session.messageCount}\n*Cost:* $${session.totalCostUsd.toFixed(4)}\n*Started:* ${session.startedAt}`,
          'Markdown'
        );
        break;
      }

      case 'model': {
        if (!cmd.args) {
          const current = this.sessionStore.getUser(agentId, cmd.userId).model
            || resolveUserConfig(agent.config, cmd.userId).model;
          await agent.tgBot.sendText(cmd.chatId, `Current model: ${current}\n\nUsage: /model <model-name>`);
          break;
        }
        this.sessionStore.setModel(agentId, cmd.userId, cmd.args.trim());
        await agent.tgBot.sendText(cmd.chatId, `Model set to \`${cmd.args.trim()}\`. Takes effect on next spawn.`, 'Markdown');
        break;
      }

      case 'repo': {
        if (!cmd.args) {
          const current = this.sessionStore.getUser(agentId, cmd.userId).repo
            || resolveUserConfig(agent.config, cmd.userId).repo;
          // Show available repos from registry
          const repoEntries = Object.entries(this.config.repos);
          if (repoEntries.length > 0) {
            const lines = repoEntries.map(([name, path]) => `• \`${name}\` → ${path}`);
            await agent.tgBot.sendText(cmd.chatId,
              `Current repo: ${current}\n\n*Available repos:*\n${lines.join('\n')}\n\nUsage: /repo <name or path>`,
              'Markdown',
            );
          } else {
            await agent.tgBot.sendText(cmd.chatId, `Current repo: ${current}\n\nUsage: /repo <path>`);
          }
          break;
        }
        // Resolve repo name from registry, or use as direct path
        const repoPath = resolveRepoPath(this.config.repos, cmd.args.trim());
        if (!existsSync(repoPath)) {
          await agent.tgBot.sendText(cmd.chatId, `Path not found: ${repoPath}`);
          break;
        }
        // Kill current process (different CWD needs new process)
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        this.sessionStore.setRepo(agentId, cmd.userId, repoPath);
        this.sessionStore.clearSession(agentId, cmd.userId);
        await agent.tgBot.sendText(cmd.chatId, `Repo set to \`${repoPath}\`. Session cleared.`, 'Markdown');
        break;
      }

      case 'cancel': {
        const proc = agent.processes.get(cmd.userId);
        if (proc && proc.state === 'active') {
          proc.cancel();
          await agent.tgBot.sendText(cmd.chatId, 'Cancelled.');
        } else {
          await agent.tgBot.sendText(cmd.chatId, 'No active turn to cancel.');
        }
        break;
      }

      case 'catchup': {
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const repo = userState.repo || resolveUserConfig(agent.config, cmd.userId).repo;
        const lastActivity = new Date(userState.lastActivity || 0);
        const missed = findMissedSessions(repo, userState.knownSessionIds, lastActivity);
        const message = formatCatchupMessage(repo, missed);
        await agent.tgBot.sendText(cmd.chatId, message, 'Markdown');
        break;
      }
    }
  }

  // ── Callback query handling (inline buttons) ──

  private async handleCallbackQuery(agentId: string, query: CallbackQuery): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.logger.debug({ agentId, action: query.action, data: query.data }, 'Callback query');

    switch (query.action) {
      case 'resume': {
        const sessionId = query.data;
        const proc = agent.processes.get(query.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(query.userId);
        }
        this.sessionStore.setCurrentSession(agentId, query.userId, sessionId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Session set');
        await agent.tgBot.sendText(
          query.chatId,
          `Will resume session \`${sessionId.slice(0, 8)}\` on next message.`,
          'Markdown',
        );
        break;
      }

      case 'delete': {
        const sessionId = query.data;
        const deleted = this.sessionStore.deleteSession(agentId, query.userId, sessionId);
        if (deleted) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Session deleted');
          await agent.tgBot.sendText(query.chatId, `Session \`${sessionId.slice(0, 8)}\` deleted.`, 'Markdown');
        } else {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Session not found');
        }
        break;
      }

      default:
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId);
    }
  }

  // ── MCP tool handling ──

  private async handleMcpToolRequest(request: McpToolRequest): Promise<McpToolResponse> {
    const agent = this.agents.get(request.agentId);
    if (!agent) {
      return { id: request.id, success: false, error: `Unknown agent: ${request.agentId}` };
    }

    // Find the chat ID for this user (from the most recent message)
    // We use the userId to find which chat to send to
    const chatId = Number(request.userId); // In TG, private chat ID === user ID

    try {
      switch (request.tool) {
        case 'send_file':
          await agent.tgBot.sendFile(chatId, request.params.path, request.params.caption);
          return { id: request.id, success: true };

        case 'send_image':
          await agent.tgBot.sendImage(chatId, request.params.path, request.params.caption);
          return { id: request.id, success: true };

        case 'send_voice':
          await agent.tgBot.sendVoice(chatId, request.params.path, request.params.caption);
          return { id: request.id, success: true };

        default:
          return { id: request.id, success: false, error: `Unknown tool: ${request.tool}` };
      }
    } catch (err) {
      return { id: request.id, success: false, error: err instanceof Error ? err.message : 'Unknown error' };
    }
  }

  // ── Shutdown ──

  async stop(): Promise<void> {
    this.logger.info('Stopping bridge');

    for (const agentId of [...this.agents.keys()]) {
      await this.stopAgent(agentId);
    }

    this.mcpServer.closeAll();
    this.logger.info('Bridge stopped');
  }
}

// ── Helpers ──

function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
