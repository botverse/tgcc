import { join } from 'node:path';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type {
  TgccConfig,
  AgentConfig,
  ConfigDiff,
} from './config.js';
import { resolveUserConfig, resolveRepoPath, updateConfig, isValidRepoName, findRepoOwner } from './config.js';
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
import { StreamAccumulator, SubAgentTracker, splitText, type TelegramSender, type SubAgentSender } from './streaming.js';
import { TelegramBot, type TelegramMessage, type SlashCommand, type CallbackQuery } from './telegram.js';
import { InlineKeyboard } from 'grammy';
import { McpBridgeServer, type McpToolRequest, type McpToolResponse } from './mcp-bridge.js';
import {
  SessionStore,
  findMissedSessions,
  formatCatchupMessage,
  getSessionJsonlPath,
  summarizeJsonlDelta,
} from './session.js';
import {
  CtlServer,
  type CtlHandler,
  type CtlAckResponse,
  type CtlStatusResponse,
} from './ctl-server.js';

// ── Types ──

interface AgentInstance {
  id: string;
  config: AgentConfig;
  tgBot: TelegramBot;
  processes: Map<string, CCProcess>;       // userId → CCProcess
  accumulators: Map<string, StreamAccumulator>; // `${userId}:${chatId}` → accumulator
  subAgentTrackers: Map<string, SubAgentTracker>; // `${userId}:${chatId}` → tracker
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
/permissions — Set permission mode
/repo — List repos (buttons)
/repo help — Repo management commands
/repo add <name> <path> — Register a repo
/repo remove <name> — Unregister a repo
/repo assign <name> — Set as agent default
/repo clear — Clear agent default

/help — This message`;

// ── Bridge ──

export class Bridge extends EventEmitter implements CtlHandler {
  private config: TgccConfig;
  private agents = new Map<string, AgentInstance>();
  private mcpServer: McpBridgeServer;
  private ctlServer: CtlServer;
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
    this.ctlServer = new CtlServer(this, this.logger);
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
      subAgentTrackers: new Map(),
      batchers: new Map(),
      pendingTitles: new Map(),
    };

    this.agents.set(agentId, instance);
    await tgBot.start();

    // Start control socket for CLI access
    const ctlSocketPath = join('/tmp/tgcc/ctl', `${agentId}.sock`);
    this.ctlServer.listen(ctlSocketPath);
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

    // Close control socket
    const ctlSocketPath = join('/tmp/tgcc/ctl', `${agentId}.sock`);
    this.ctlServer.close(ctlSocketPath);

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
    if (proc?.takenOver) {
      // Session was taken over externally — discard old process
      proc.destroy();
      agent.processes.delete(userId);
      proc = undefined;
    }

    // Staleness check: detect if session was modified by another client
    if (proc && proc.state !== 'idle') {
      const staleInfo = this.checkSessionStaleness(agentId, userId);
      if (staleInfo) {
        this.logger.info({ agentId, userId }, 'Session stale — killing process for reconnect');
        proc.destroy();
        agent.processes.delete(userId);
        proc = undefined;
        agent.tgBot.sendText(chatId, staleInfo.summary, 'Markdown');
      }
    }

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

  /** Check if the session JSONL was modified externally since we last tracked it. */
  private checkSessionStaleness(agentId: string, userId: string): { summary: string } | null {
    const userState = this.sessionStore.getUser(agentId, userId);
    const sessionId = userState.currentSessionId;
    if (!sessionId) return null;

    const repo = userState.repo || resolveUserConfig(
      this.agents.get(agentId)!.config, userId,
    ).repo;

    const jsonlPath = getSessionJsonlPath(sessionId, repo);
    const tracking = this.sessionStore.getJsonlTracking(agentId, userId);

    // No tracking yet (first message or new session) — not stale
    if (!tracking) return null;

    try {
      const stat = statSync(jsonlPath);
      // File grew or was modified since we last tracked
      if (stat.size <= tracking.size && stat.mtimeMs <= tracking.mtimeMs) {
        return null;
      }

      // Session is stale — build a summary of what happened
      const summary = summarizeJsonlDelta(jsonlPath, tracking.size)
        ?? '_ℹ️ Session was updated from another client. Reconnecting..._';

      return { summary };
    } catch {
      // File doesn't exist or stat failed — skip check
      return null;
    }
  }

  /** Update JSONL tracking from the current file state. */
  private updateJsonlTracking(agentId: string, userId: string): void {
    const userState = this.sessionStore.getUser(agentId, userId);
    const sessionId = userState.currentSessionId;
    if (!sessionId) return;

    const repo = userState.repo || resolveUserConfig(
      this.agents.get(agentId)!.config, userId,
    ).repo;

    const jsonlPath = getSessionJsonlPath(sessionId, repo);

    try {
      const stat = statSync(jsonlPath);
      this.sessionStore.updateJsonlTracking(agentId, userId, stat.size, stat.mtimeMs);
    } catch {
      // File doesn't exist yet — clear tracking
      this.sessionStore.clearJsonlTracking(agentId, userId);
    }
  }

  private spawnCCProcess(agentId: string, userId: string, chatId: number): CCProcess {
    const agent = this.agents.get(agentId)!;
    const userConfig = resolveUserConfig(agent.config, userId);

    // Check session store for model/repo/permission overrides
    const userState = this.sessionStore.getUser(agentId, userId);
    if (userState.model) userConfig.model = userState.model;
    if (userState.repo) userConfig.repo = userState.repo;
    if (userState.permissionMode) {
      userConfig.permissionMode = userState.permissionMode as typeof userConfig.permissionMode;
    }

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
      // Initialize JSONL tracking for staleness detection
      this.updateJsonlTracking(agentId, userId);
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

    proc.on('takeover', () => {
      this.logger.warn({ agentId, userId }, 'Session takeover detected');
      // Clear session so next message starts fresh instead of --resume
      this.sessionStore.clearSession(agentId, userId);
      agent.tgBot.sendText(
        chatId,
        '_Session was picked up by another client. Next message will start a fresh session._',
        'Markdown',
      );
    });

    proc.on('exit', () => {
      // Finalize any active accumulator
      const accKey = `${userId}:${chatId}`;
      const acc = agent.accumulators.get(accKey);
      if (acc) {
        acc.finalize();
        agent.accumulators.delete(accKey);
      }
      // Clean up sub-agent tracker
      agent.subAgentTrackers.delete(accKey);
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

    // Sub-agent tracker — create lazily alongside the accumulator
    let tracker = agent.subAgentTrackers.get(accKey);
    if (!tracker) {
      const subAgentSender: SubAgentSender = {
        replyToMessage: (cid, text, replyTo, parseMode) =>
          agent.tgBot.replyToMessage(cid, text, replyTo, parseMode),
        editMessage: (cid, msgId, text, parseMode) =>
          agent.tgBot.editText(cid, msgId, text, parseMode),
      };
      tracker = new SubAgentTracker({
        chatId,
        sender: subAgentSender,
        getMainMessageId: () => {
          const ids = acc!.allMessageIds;
          return ids.length > 0 ? ids[0] : null;
        },
      });
      agent.subAgentTrackers.set(accKey, tracker);
    }

    acc.handleEvent(event);
    tracker.handleEvent(event);
  }

  private handleResult(agentId: string, userId: string, chatId: number, event: ResultEvent): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Finalize accumulator but keep it alive for multi-turn continuity
    const accKey = `${userId}:${chatId}`;
    const acc = agent.accumulators.get(accKey);
    if (acc) {
      acc.finalize();
      // Don't delete — next turn will softReset via message_start and edit the same message
    }

    // Update session store with cost
    if (event.total_cost_usd) {
      this.sessionStore.updateSessionActivity(agentId, userId, event.total_cost_usd);
    }

    // Update JSONL tracking after our own CC turn completes
    // This prevents false-positive staleness on our own writes
    this.updateJsonlTracking(agentId, userId);

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
      case 'start': {
        await agent.tgBot.sendText(
          cmd.chatId,
          '👋 TGCC — Telegram ↔ Claude Code bridge\n\nSend me a message to start a CC session, or use /help for commands.',
        );
        // Re-register commands with BotFather to ensure menu is up to date
        try {
          const { COMMANDS } = await import('./telegram.js');
          await agent.tgBot.bot.api.setMyCommands(COMMANDS);
        } catch {}
        break;
      }

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
        const repoArgs = cmd.args?.trim().split(/\s+/) ?? [];
        const repoSub = repoArgs[0];
        this.logger.debug({ repoSub, repoArgs, repos: Object.keys(this.config.repos), hasArgs: !!cmd.args, argsRaw: cmd.args }, '/repo command debug');

        if (repoSub === 'add') {
          // /repo add <name> <path>
          const repoName = repoArgs[1];
          const repoAddPath = repoArgs[2];
          if (!repoName || !repoAddPath) {
            await agent.tgBot.sendText(cmd.chatId, 'Usage: /repo add <name> <path>');
            break;
          }
          if (!isValidRepoName(repoName)) {
            await agent.tgBot.sendText(cmd.chatId, 'Invalid repo name. Use alphanumeric + hyphens only.');
            break;
          }
          if (!existsSync(repoAddPath)) {
            await agent.tgBot.sendText(cmd.chatId, `Path not found: ${repoAddPath}`);
            break;
          }
          if (this.config.repos[repoName]) {
            await agent.tgBot.sendText(cmd.chatId, `Repo "${repoName}" already exists.`);
            break;
          }
          updateConfig((cfg) => {
            const repos = (cfg.repos ?? {}) as Record<string, string>;
            repos[repoName] = repoAddPath;
            cfg.repos = repos;
          });
          await agent.tgBot.sendText(cmd.chatId, `Repo \`${repoName}\` added → ${repoAddPath}`, 'Markdown');
          break;
        }

        if (repoSub === 'remove') {
          // /repo remove <name>
          const repoName = repoArgs[1];
          if (!repoName) {
            await agent.tgBot.sendText(cmd.chatId, 'Usage: /repo remove <name>');
            break;
          }
          if (!this.config.repos[repoName]) {
            await agent.tgBot.sendText(cmd.chatId, `Repo "${repoName}" not found.`);
            break;
          }
          // Check if any agent has it assigned
          const rawCfg = JSON.parse(readFileSync(join(homedir(), '.tgcc', 'config.json'), 'utf-8'));
          const owner = findRepoOwner(rawCfg, repoName);
          if (owner) {
            await agent.tgBot.sendText(cmd.chatId, `Can't remove: repo "${repoName}" is assigned to agent "${owner}". Use /repo clear on that agent first.`);
            break;
          }
          updateConfig((cfg) => {
            const repos = (cfg.repos ?? {}) as Record<string, string>;
            delete repos[repoName];
            cfg.repos = repos;
          });
          await agent.tgBot.sendText(cmd.chatId, `Repo \`${repoName}\` removed.`, 'Markdown');
          break;
        }

        if (repoSub === 'assign') {
          // /repo assign <name> — assign to THIS agent
          const repoName = repoArgs[1];
          if (!repoName) {
            await agent.tgBot.sendText(cmd.chatId, 'Usage: /repo assign <name>');
            break;
          }
          if (!this.config.repos[repoName]) {
            await agent.tgBot.sendText(cmd.chatId, `Repo "${repoName}" not found in registry.`);
            break;
          }
          const rawCfg2 = JSON.parse(readFileSync(join(homedir(), '.tgcc', 'config.json'), 'utf-8'));
          const existingOwner = findRepoOwner(rawCfg2, repoName);
          if (existingOwner && existingOwner !== agentId) {
            await agent.tgBot.sendText(cmd.chatId, `Repo "${repoName}" is already assigned to agent "${existingOwner}".`);
            break;
          }
          updateConfig((cfg) => {
            const agents = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>;
            const agentCfg = agents[agentId];
            if (agentCfg) {
              const defaults = (agentCfg.defaults ?? {}) as Record<string, unknown>;
              defaults.repo = repoName;
              agentCfg.defaults = defaults;
            }
          });
          await agent.tgBot.sendText(cmd.chatId, `Repo \`${repoName}\` assigned to agent \`${agentId}\`.`, 'Markdown');
          break;
        }

        if (repoSub === 'help') {
          const helpText = [
            '*Repo Management*',
            '',
            '/repo — List repos (buttons)',
            '/repo help — This help text',
            '/repo add <name> <path> — Register a repo',
            '/repo remove <name> — Unregister a repo',
            '/repo assign <name> — Set as this agent\'s default',
            '/repo clear — Clear this agent\'s default',
          ].join('\n');
          await agent.tgBot.sendText(cmd.chatId, helpText, 'Markdown');
          break;
        }

        if (repoSub === 'clear') {
          // /repo clear — clear THIS agent's default repo
          updateConfig((cfg) => {
            const agents = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>;
            const agentCfg = agents[agentId];
            if (agentCfg) {
              const defaults = (agentCfg.defaults ?? {}) as Record<string, unknown>;
              delete defaults.repo;
              agentCfg.defaults = defaults;
            }
          });
          await agent.tgBot.sendText(cmd.chatId, `Default repo cleared for agent \`${agentId}\`.`, 'Markdown');
          break;
        }

        if (!cmd.args) {
          const current = this.sessionStore.getUser(agentId, cmd.userId).repo
            || resolveUserConfig(agent.config, cmd.userId).repo;
          // Show available repos as inline keyboard buttons
          const repoEntries = Object.entries(this.config.repos);
          if (repoEntries.length > 0) {
            const keyboard = new InlineKeyboard();
            for (const [name] of repoEntries) {
              keyboard.text(name, `repo:${name}`).row();
            }
            keyboard.text('➕ Add', 'repo_add:prompt').text('❓ Help', 'repo_help:show').row();
            await agent.tgBot.sendTextWithKeyboard(
              cmd.chatId,
              `Current repo: \`${current}\`\n\nSelect a repo:\n\n_Type /repo help for management commands_`,
              keyboard,
              'Markdown',
            );
          } else {
            await agent.tgBot.sendText(cmd.chatId, `Current repo: ${current}\n\nUsage: /repo <path>`);
          }
          break;
        }

        // Fallback: /repo <path-or-name> — switch working directory for session
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

      case 'permissions': {
        const validModes = ['dangerously-skip', 'acceptEdits', 'default', 'plan'];
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const agentDefault = agent.config.defaults.permissionMode;
        const currentMode = userState.permissionMode || agentDefault;

        if (cmd.args) {
          const mode = cmd.args.trim();
          if (!validModes.includes(mode)) {
            await agent.tgBot.sendText(cmd.chatId, `Invalid mode. Valid: ${validModes.join(', ')}`);
            break;
          }
          this.sessionStore.setPermissionMode(agentId, cmd.userId, mode);
          // Kill current process so new mode takes effect on next spawn
          const proc = agent.processes.get(cmd.userId);
          if (proc) {
            proc.destroy();
            agent.processes.delete(cmd.userId);
          }
          await agent.tgBot.sendText(cmd.chatId, `Permission mode set to \`${mode}\`. Takes effect on next message.`, 'Markdown');
          break;
        }

        // No args — show current mode + inline keyboard
        const keyboard = new InlineKeyboard();
        keyboard.text('🔓 Bypass', 'permissions:dangerously-skip').text('✏️ Accept Edits', 'permissions:acceptEdits').row();
        keyboard.text('🔒 Default', 'permissions:default').text('📋 Plan', 'permissions:plan').row();

        await agent.tgBot.sendTextWithKeyboard(
          cmd.chatId,
          `Current: \`${currentMode}\`\nDefault: \`${agentDefault}\`\n\nSelect a mode for this session:`,
          keyboard,
          'Markdown',
        );
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

      case 'repo': {
        const repoName = query.data;
        const repoPath = resolveRepoPath(this.config.repos, repoName);
        if (!existsSync(repoPath)) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Path not found');
          break;
        }
        // Kill current process (different CWD needs new process)
        const proc = agent.processes.get(query.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(query.userId);
        }
        this.sessionStore.setRepo(agentId, query.userId, repoPath);
        this.sessionStore.clearSession(agentId, query.userId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Repo: ${repoName}`);
        await agent.tgBot.sendText(query.chatId, `Repo set to \`${repoPath}\`. Session cleared.`, 'Markdown');
        break;
      }

      case 'repo_add': {
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Usage below');
        await agent.tgBot.sendText(query.chatId, 'Send: `/repo add <name> <path>`', 'Markdown');
        break;
      }

      case 'permissions': {
        const validModes = ['dangerously-skip', 'acceptEdits', 'default', 'plan'];
        const mode = query.data;
        if (!validModes.includes(mode)) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Invalid mode');
          break;
        }
        this.sessionStore.setPermissionMode(agentId, query.userId, mode);
        // Kill current process so new mode takes effect on next spawn
        const proc = agent.processes.get(query.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(query.userId);
        }
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Mode: ${mode}`);
        await agent.tgBot.sendText(
          query.chatId,
          `Permission mode set to \`${mode}\`. Takes effect on next message.`,
          'Markdown',
        );
        break;
      }

      case 'repo_help': {
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId);
        const helpText = [
          '*Repo Management*',
          '',
          '/repo — List repos (buttons)',
          '/repo help — This help text',
          '/repo add <name> <path> — Register a repo',
          '/repo remove <name> — Unregister a repo',
          '/repo assign <name> — Set as this agent\'s default',
          '/repo clear — Clear this agent\'s default',
        ].join('\n');
        await agent.tgBot.sendText(query.chatId, helpText, 'Markdown');
        break;
      }

      default:
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId);
    }
  }

  // ── Control socket handlers (CLI interface) ──

  handleCtlMessage(agentId: string, text: string, sessionId?: string): CtlAckResponse {
    const agent = this.agents.get(agentId);
    if (!agent) {
      // Return error via the CtlAckResponse shape won't work — but the ctl-server
      // protocol handles errors separately. We'll throw and let it catch.
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Use the first allowed user as the "CLI user" identity
    const userId = agent.config.allowedUsers[0];
    const chatId = Number(userId);

    // If explicit session requested, set it
    if (sessionId) {
      this.sessionStore.setCurrentSession(agentId, userId, sessionId);
    }

    // Route through the same sendToCC path as Telegram
    this.sendToCC(agentId, userId, chatId, { text });

    const proc = agent.processes.get(userId);
    return {
      type: 'ack',
      sessionId: proc?.sessionId ?? this.sessionStore.getUser(agentId, userId).currentSessionId,
      state: proc?.state ?? 'idle',
    };
  }

  handleCtlStatus(agentId?: string): CtlStatusResponse {
    const agents: CtlStatusResponse['agents'] = [];
    const sessions: CtlStatusResponse['sessions'] = [];

    const agentIds = agentId ? [agentId] : [...this.agents.keys()];

    for (const id of agentIds) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      // Aggregate process state across users
      let state = 'idle';
      for (const [, proc] of agent.processes) {
        if (proc.state === 'active') { state = 'active'; break; }
        if (proc.state === 'spawning') state = 'spawning';
      }

      const userId = agent.config.allowedUsers[0];
      const proc = agent.processes.get(userId);
      const userConfig = resolveUserConfig(agent.config, userId);

      agents.push({
        id,
        state,
        sessionId: proc?.sessionId ?? null,
        repo: this.sessionStore.getUser(id, userId).repo || userConfig.repo,
      });

      // List sessions for this agent
      const userState = this.sessionStore.getUser(id, userId);
      for (const sess of userState.sessions.slice(-5).reverse()) {
        sessions.push({
          id: sess.id,
          agentId: id,
          messageCount: sess.messageCount,
          totalCostUsd: sess.totalCostUsd,
        });
      }
    }

    return { type: 'status', agents, sessions };
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
    this.ctlServer.closeAll();
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
