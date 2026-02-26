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
import type { ApiErrorEvent, PermissionRequest, ToolResultEvent, TaskStartedEvent, TaskProgressEvent, TaskCompletedEvent } from './cc-protocol.js';
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
import { StreamAccumulator, SubAgentTracker, splitText, escapeHtml, type TelegramSender, type SubAgentSender, type MailboxMessage } from './streaming.js';
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

interface PendingPermission {
  requestId: string;
  userId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface AgentInstance {
  id: string;
  config: AgentConfig;
  tgBot: TelegramBot;
  processes: Map<string, CCProcess>;       // userId → CCProcess
  accumulators: Map<string, StreamAccumulator>; // `${userId}:${chatId}` → accumulator
  subAgentTrackers: Map<string, SubAgentTracker>; // `${userId}:${chatId}` → tracker
  batchers: Map<string, MessageBatcher>;   // userId → batcher
  pendingTitles: Map<string, string>;      // userId → first message text for session title
  pendingPermissions: Map<string, PendingPermission>; // requestId → pending permission
  typingIntervals: Map<string, ReturnType<typeof setInterval>>; // `${userId}:${chatId}` → interval
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

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ── Help text ──

const HELP_TEXT = `<b>TGCC Commands</b>

<b>Session</b>
/new — Start a fresh session
/continue — Respawn process, keep session
/sessions — List recent sessions
/resume &lt;id&gt; — Resume a session by ID
/session — Current session info

<b>Info</b>
/status — Process state, model, uptime
/cost — Show session cost
/catchup — Summarize external CC activity
/ping — Liveness check

<b>Control</b>
/cancel — Abort current CC turn
/model &lt;name&gt; — Switch model
/permissions — Set permission mode
/repo — List repos (buttons)
/repo help — Repo management commands
/repo add &lt;name&gt; &lt;path&gt; — Register a repo
/repo remove &lt;name&gt; — Unregister a repo
/repo assign &lt;name&gt; — Set as agent default
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
      pendingPermissions: new Map(),
      typingIntervals: new Map(),
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

    // Kill all CC processes and wait for them to exit
    const processExitPromises: Promise<void>[] = [];
    for (const [, proc] of agent.processes) {
      // Create a promise that resolves when the process exits or times out
      const exitPromise = new Promise<void>((resolve) => {
        const onExit = () => {
          proc.off('exit', onExit);
          resolve();
        };
        proc.on('exit', onExit);
        
        // Timeout after 3 seconds if process doesn't exit
        const timeoutId = setTimeout(() => {
          proc.off('exit', onExit);
          resolve();
        }, 3000);
        
        // Clear timeout if process exits before timeout
        proc.on('exit', () => clearTimeout(timeoutId));
      });
      
      processExitPromises.push(exitPromise);
      proc.destroy();
    }

    // Wait for all processes to exit (or timeout)
    await Promise.all(processExitPromises);

    // Cancel batchers
    for (const [, batcher] of agent.batchers) {
      batcher.cancel();
      batcher.destroy();
    }

    // Close MCP sockets
    for (const userId of agent.processes.keys()) {
      const socketPath = join(this.config.global.socketDir, `${agentId}-${userId}.sock`);
      this.mcpServer.close(socketPath);
    }

    // Clean up accumulators (clears edit timers)
    for (const [, acc] of agent.accumulators) {
      acc.finalize();
    }
    agent.accumulators.clear();

    // Clean up sub-agent trackers (stops mailbox watchers)
    for (const [, tracker] of agent.subAgentTrackers) {
      tracker.reset();
    }
    agent.subAgentTrackers.clear();

    // Clear remaining maps
    // Clear typing indicators
    for (const [, interval] of agent.typingIntervals) {
      clearInterval(interval);
    }
    agent.typingIntervals.clear();

    agent.pendingTitles.clear();
    agent.pendingPermissions.clear();
    agent.processes.clear();
    agent.batchers.clear();

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
    // Skip if background sub-agents are running — their results grow the JSONL
    // and would cause false-positive staleness detection
    const accKey2 = `${userId}:${chatId}`;
    const activeTracker = agent.subAgentTrackers.get(accKey2);
    const hasBackgroundAgents = activeTracker?.hasDispatchedAgents ?? false;
    if (proc && proc.state !== 'idle' && !hasBackgroundAgents) {
      const staleInfo = this.checkSessionStaleness(agentId, userId);
      if (staleInfo) {
        // Session was modified externally — silently reconnect for roaming support
        this.logger.info({ agentId, userId }, 'Session modified externally — reconnecting for roaming');
        proc.destroy();
        agent.processes.delete(userId);
        proc = undefined;
      }
    }

    if (!proc || proc.state === 'idle') {
      // Warn if no repo is configured — CC would run in ~ which is likely not intended
      const userState2 = this.sessionStore.getUser(agentId, userId);
      const resolvedRepo = userState2.repo || resolveUserConfig(agent.config, userId).repo;
      if (resolvedRepo === homedir()) {
        agent.tgBot.sendText(
          chatId,
          '<blockquote>⚠️ No project selected. Use /repo to pick one, or CC will run in your home directory.</blockquote>',
          'HTML',
        ).catch(err => this.logger.error({ err }, 'Failed to send no-repo warning'));
      }

      // Save first message text as pending session title
      if (data.text) {
        agent.pendingTitles.set(userId, data.text);
      }
      proc = this.spawnCCProcess(agentId, userId, chatId);
      agent.processes.set(userId, proc);
    }

    // Show typing indicator (repeated every 4s — TG typing expires after ~5s)
    this.startTypingIndicator(agent, userId, chatId);

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
        ?? '<i>ℹ️ Session was updated from another client. Reconnecting...</i>';

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

  // ── Typing indicator management ──

  private startTypingIndicator(agent: AgentInstance, userId: string, chatId: number): void {
    const key = `${userId}:${chatId}`;
    // Don't create duplicate intervals
    if (agent.typingIntervals.has(key)) return;
    // Send immediately, then repeat every 4s (TG typing badge lasts ~5s)
    agent.tgBot.sendTyping(chatId);
    const interval = setInterval(() => {
      agent.tgBot.sendTyping(chatId);
    }, 4_000);
    agent.typingIntervals.set(key, interval);
  }

  private stopTypingIndicator(agent: AgentInstance, userId: string, chatId: number): void {
    const key = `${userId}:${chatId}`;
    const interval = agent.typingIntervals.get(key);
    if (interval) {
      clearInterval(interval);
      agent.typingIntervals.delete(key);
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
    const mcpServerPath = resolveMcpServerPath();
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

    proc.on('tool_result', (event: ToolResultEvent) => {
      const accKey = `${userId}:${chatId}`;

      // Resolve tool indicator message with success/failure status
      const acc2 = agent.accumulators.get(accKey);
      if (acc2 && event.tool_use_id) {
        const isError = event.is_error === true;
        const contentStr = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
        const errorMsg = isError ? contentStr : undefined;
        acc2.resolveToolMessage(event.tool_use_id, isError, errorMsg, contentStr);
      }

      const tracker = agent.subAgentTrackers.get(accKey);
      if (!tracker) return;

      const resultText = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
      const meta = event.tool_use_result;

      // Log warning if structured metadata is missing
      if (!meta && /agent_id:\s*\S+@\S+/.test(resultText)) {
        this.logger.warn({ agentId, toolUseId: event.tool_use_id }, 'Spawn detected in text but no structured tool_use_result metadata - skipping');
      }

      const spawnMeta = meta?.status === 'teammate_spawned' ? meta : undefined;

      if (spawnMeta?.status === 'teammate_spawned' && spawnMeta.team_name) {
        if (!tracker.currentTeamName) {
          this.logger.info({ agentId, teamName: spawnMeta.team_name, agentName: spawnMeta.name, agentType: spawnMeta.agent_type }, 'Spawn detected');
          tracker.setTeamName(spawnMeta.team_name!);

          // Wire the "all agents reported" callback to send follow-up to CC
          tracker.setOnAllReported(() => {
            const ccProc = agent.processes.get(userId);
            if (ccProc && ccProc.state === 'active') {
              ccProc.sendMessage(createTextMessage(
                '[System] All background agents have reported back. Please read their results from the mailbox/files and provide a synthesis to the user.',
              ));
            }
          });
        }

        // Set agent metadata from structured data or text fallback
        if (event.tool_use_id && spawnMeta.name) {
          tracker.setAgentMetadata(event.tool_use_id, {
            agentName: spawnMeta.name,
            agentType: spawnMeta.agent_type,
            color: spawnMeta.color,
          });
        }
      }

      // Handle tool result (sets status, edits TG message)
      if (event.tool_use_id) {
        tracker.handleToolResult(event.tool_use_id, resultText);
      }

      // Start mailbox watch AFTER handleToolResult has set agent names
      if (tracker.currentTeamName && tracker.hasDispatchedAgents && !tracker.isMailboxWatching) {
        tracker.startMailboxWatch();
      }
    });

    // System events for background task tracking
    proc.on('task_started', (event: TaskStartedEvent) => {
      const accKey = `${userId}:${chatId}`;
      const tracker = agent.subAgentTrackers.get(accKey);
      if (tracker) {
        tracker.handleTaskStarted(event.tool_use_id, event.description, event.task_type);
      }
    });

    proc.on('task_progress', (event: TaskProgressEvent) => {
      const accKey = `${userId}:${chatId}`;
      const tracker = agent.subAgentTrackers.get(accKey);
      if (tracker) {
        tracker.handleTaskProgress(event.tool_use_id, event.description, event.last_tool_name);
      }
    });

    proc.on('task_completed', (event: TaskCompletedEvent) => {
      const accKey = `${userId}:${chatId}`;
      const tracker = agent.subAgentTrackers.get(accKey);
      if (tracker) {
        tracker.handleTaskCompleted(event.tool_use_id);
      }
    });

    // Media from tool results (images, PDFs, etc.)
    proc.on('media', (media: { kind: string; media_type: string; data: string }) => {
      const buf = Buffer.from(media.data, 'base64');
      if (media.kind === 'image') {
        agent.tgBot.sendPhotoBuffer(chatId, buf).catch(err => {
          this.logger.error({ err, agentId, userId }, 'Failed to send tool_result image');
        });
      } else if (media.kind === 'document') {
        const ext = media.media_type === 'application/pdf' ? '.pdf' : '';
        agent.tgBot.sendDocumentBuffer(chatId, buf, `document${ext}`).catch(err => {
          this.logger.error({ err, agentId, userId }, 'Failed to send tool_result document');
        });
      }
    });

    proc.on('assistant', (event: AssistantMessage) => {
      // Non-streaming fallback — only used if stream_events don't fire
      // In practice, stream_events handle the display
    });

    proc.on('result', (event: ResultEvent) => {
      this.stopTypingIndicator(agent, userId, chatId);
      this.handleResult(agentId, userId, chatId, event);
    });

    proc.on('permission_request', (event: PermissionRequest) => {
      const req = event.request;
      const requestId = event.request_id;

      // Store pending permission
      agent.pendingPermissions.set(requestId, {
        requestId,
        userId,
        toolName: req.tool_name,
        input: req.input,
      });

      // Build description of what CC wants to do
      const toolName = escapeHtml(req.tool_name);
      const inputPreview = req.input
        ? escapeHtml(JSON.stringify(req.input).slice(0, 200))
        : '';

      const text = inputPreview
        ? `🔐 CC wants to use <code>${toolName}</code>\n<pre>${inputPreview}</pre>`
        : `🔐 CC wants to use <code>${toolName}</code>`;

      const keyboard = new InlineKeyboard()
        .text('✅ Allow', `perm_allow:${requestId}`)
        .text('❌ Deny', `perm_deny:${requestId}`)
        .text('✅ Allow All', `perm_allow_all:${userId}`);

      agent.tgBot.sendTextWithKeyboard(chatId, text, keyboard, 'HTML')
        .catch(err => this.logger.error({ err }, 'Failed to send permission request'));
    });

    proc.on('api_error', (event: ApiErrorEvent) => {
      const errMsg = event.error?.message || 'Unknown API error';
      const status = event.error?.status;
      const isOverloaded = status === 529 || errMsg.includes('overloaded');
      const retryInfo = event.retryAttempt != null && event.maxRetries != null
        ? ` (retry ${event.retryAttempt}/${event.maxRetries})`
        : '';

      const text = isOverloaded
        ? `<blockquote>⚠️ API overloaded, retrying...${retryInfo}</blockquote>`
        : `<blockquote>⚠️ ${escapeHtml(errMsg)}${retryInfo}</blockquote>`;

      agent.tgBot.sendText(chatId, text, 'HTML')
        .catch(err => this.logger.error({ err }, 'Failed to send API error notification'));
    });

    proc.on('hang', () => {
      this.stopTypingIndicator(agent, userId, chatId);
      agent.tgBot.sendText(chatId, '<blockquote>⏸ Session paused. Send a message to continue.</blockquote>', 'HTML')
        .catch(err => this.logger.error({ err }, 'Failed to send hang notification'));
    });

    proc.on('takeover', () => {
      this.stopTypingIndicator(agent, userId, chatId);
      this.logger.warn({ agentId, userId }, 'Session takeover detected — keeping session for roaming');
      // Don't clear session — allow roaming between clients.
      // Just kill the current process; next message will --resume the same session.
      proc.destroy();
      agent.processes.delete(userId);
    });

    proc.on('exit', () => {
      this.stopTypingIndicator(agent, userId, chatId);
      // Finalize any active accumulator
      const accKey = `${userId}:${chatId}`;
      const acc = agent.accumulators.get(accKey);
      if (acc) {
        acc.finalize();
        agent.accumulators.delete(accKey);
      }
      // Clean up sub-agent tracker (stops mailbox watch)
      const exitTracker = agent.subAgentTrackers.get(accKey);
      if (exitTracker) {
        exitTracker.stopMailboxWatch();
      }
      agent.subAgentTrackers.delete(accKey);
    });

    proc.on('error', (err: Error) => {
      this.stopTypingIndicator(agent, userId, chatId);
      agent.tgBot.sendText(chatId, `<blockquote>⚠️ ${escapeHtml(String(err.message))}</blockquote>`, 'HTML')
        .catch(err2 => this.logger.error({ err: err2 }, 'Failed to send process error notification'));
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
        deleteMessage: (cid, msgId) => agent.tgBot.deleteMessage(cid, msgId),
        sendPhoto: (cid, buffer, caption) => agent.tgBot.sendPhotoBuffer(cid, buffer, caption),
      };
      const onError = (err: unknown, context: string) => {
        this.logger.error({ err, context, agentId, userId }, 'Stream accumulator error');
        agent.tgBot.sendText(chatId, `<blockquote>⚠️ ${escapeHtml(context)}</blockquote>`, 'HTML').catch(() => {});
      };
      acc = new StreamAccumulator({ chatId, sender, logger: this.logger, onError });
      agent.accumulators.set(accKey, acc);
    }

    // Sub-agent tracker — create lazily alongside the accumulator
    let tracker = agent.subAgentTrackers.get(accKey);
    if (!tracker) {
      const subAgentSender: SubAgentSender = {
        sendMessage: (cid, text, parseMode) =>
          agent.tgBot.sendText(cid, text, parseMode),
        editMessage: (cid, msgId, text, parseMode) =>
          agent.tgBot.editText(cid, msgId, text, parseMode),
        setReaction: (cid, msgId, emoji) =>
          agent.tgBot.setReaction(cid, msgId, emoji),
      };
      tracker = new SubAgentTracker({
        chatId,
        sender: subAgentSender,
      });
      agent.subAgentTrackers.set(accKey, tracker);
    }

    // On message_start: new CC turn — full reset for text accumulator.
    // Tool indicator messages are independent and persist across turns.
    if (event.type === 'message_start') {
      acc.reset();
      // Only reset tracker if no agents still dispatched
      if (!tracker.hasDispatchedAgents) {
        tracker.reset();
      }
    }

    acc.handleEvent(event);
    tracker.handleEvent(event);
  }

  private handleResult(agentId: string, userId: string, chatId: number, event: ResultEvent): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Set usage stats on the accumulator before finalizing
    const accKey = `${userId}:${chatId}`;
    const acc = agent.accumulators.get(accKey);
    if (acc) {
      // Extract usage from result event
      if (event.usage) {
        acc.setTurnUsage({
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
          cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: event.usage.cache_creation_input_tokens ?? 0,
          costUsd: event.total_cost_usd ?? null,
        });
      }
      acc.finalize();
      // Don't delete — next turn will reset via message_start and create a new message
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
      agent.tgBot.sendText(chatId, `<blockquote>⚠️ ${escapeHtml(String(event.result))}</blockquote>`, 'HTML')
        .catch(err => this.logger.error({ err }, 'Failed to send result error notification'));
    }

    // If background sub-agents are still running, mailbox watcher handles them.
    // Ensure mailbox watch is started if we have a team name and dispatched agents.
    const tracker = agent.subAgentTrackers.get(accKey);
    if (tracker?.hasDispatchedAgents && tracker.currentTeamName) {
      this.logger.info({ agentId }, 'Turn ended with background sub-agents still running');
      // Clear idle timer — don't kill CC while background agents are working
      const ccProcess = agent.processes.get(userId);
      if (ccProcess) ccProcess.clearIdleTimer();
      // Start mailbox watcher (works for general-purpose agents that have SendMessage)
      tracker.startMailboxWatch();
      // Fallback: send ONE follow-up after 60s if mailbox hasn't resolved all agents
      // This handles bash-type agents that can't write to mailbox
      if (!tracker.hasPendingFollowUp) {
        tracker.hasPendingFollowUp = true;
        setTimeout(() => {
          if (!tracker.hasDispatchedAgents) return; // already resolved via mailbox
          const proc = agent.processes.get(userId);
          if (!proc) return;
          this.logger.info({ agentId }, 'Mailbox timeout — sending single follow-up for remaining agents');
          // Mark all remaining dispatched agents as completed (CC already has the results)
          for (const info of tracker.activeAgents) {
            if (info.status === 'dispatched') {
              tracker.markCompleted(info.toolUseId, '(results delivered in CC response)');
            }
          }
          proc.sendMessage(createTextMessage('[System] The background agents should be done by now. Please read their results from the mailbox/files and report to the user.'));
        }, 60_000);
      }
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
        await agent.tgBot.sendText(cmd.chatId, HELP_TEXT, 'HTML');
        break;

      case 'ping': {
        const proc = agent.processes.get(cmd.userId);
        const state = proc?.state ?? 'idle';
        await agent.tgBot.sendText(cmd.chatId, `pong — process: <b>${state.toUpperCase()}</b>`, 'HTML');
        break;
      }

      case 'status': {
        const proc = agent.processes.get(cmd.userId);
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const uptime = proc?.spawnedAt
          ? formatDuration(Date.now() - proc.spawnedAt.getTime())
          : 'N/A';

        const status = [
          `<b>Agent:</b> ${escapeHtml(agentId)}`,
          `<b>Process:</b> ${(proc?.state ?? 'idle').toUpperCase()} (uptime: ${uptime})`,
          `<b>Session:</b> <code>${escapeHtml(proc?.sessionId?.slice(0, 8) ?? 'none')}</code>`,
          `<b>Model:</b> ${escapeHtml(userState.model || resolveUserConfig(agent.config, cmd.userId).model)}`,
          `<b>Repo:</b> ${escapeHtml(userState.repo || resolveUserConfig(agent.config, cmd.userId).repo)}`,
          `<b>Cost:</b> $${(proc?.totalCostUsd ?? 0).toFixed(4)}`,
        ].join('\n');
        await agent.tgBot.sendText(cmd.chatId, status, 'HTML');
        break;
      }

      case 'cost': {
        const proc = agent.processes.get(cmd.userId);
        await agent.tgBot.sendText(cmd.chatId, `<b>Session cost:</b> $${(proc?.totalCostUsd ?? 0).toFixed(4)}`, 'HTML');
        break;
      }

      case 'new': {
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        this.sessionStore.clearSession(agentId, cmd.userId);
        await agent.tgBot.sendText(cmd.chatId, '<blockquote>Session cleared. Next message starts fresh.</blockquote>', 'HTML');
        break;
      }

      case 'continue': {
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        await agent.tgBot.sendText(cmd.chatId, '<blockquote>Process respawned. Session kept — next message continues where you left off.</blockquote>', 'HTML');
        break;
      }

      case 'sessions': {
        const sessions = this.sessionStore.getRecentSessions(agentId, cmd.userId);
        if (sessions.length === 0) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No recent sessions.</blockquote>', 'HTML');
          break;
        }
        const currentSessionId = this.sessionStore.getUser(agentId, cmd.userId).currentSessionId;

        const lines: string[] = [];
        const keyboard = new InlineKeyboard();

        sessions.forEach((s, i) => {
          const rawTitle = s.title || s.id.slice(0, 8);
          const displayTitle = s.title ? escapeHtml(s.title) : `<code>${escapeHtml(s.id.slice(0, 8))}</code>`;
          const age = formatAge(new Date(s.lastActivity));
          const isCurrent = s.id === currentSessionId;
          const current = isCurrent ? ' ✓' : '';
          lines.push(`<b>${i + 1}.</b> ${displayTitle}${current}\n    ${s.messageCount} msgs · $${s.totalCostUsd.toFixed(2)} · ${age}`);

          // Button: full title (TG allows up to ~40 chars visible), no ellipsis
          if (!isCurrent) {
            const btnLabel = rawTitle.length > 35 ? rawTitle.slice(0, 35) : rawTitle;
            keyboard.text(`${i + 1}. ${btnLabel}`, `resume:${s.id}`).row();
          }
        });

        await agent.tgBot.sendTextWithKeyboard(
          cmd.chatId,
          `📋 <b>Sessions</b>\n\n${lines.join('\n\n')}`,
          keyboard,
          'HTML',
        );
        break;
      }

      case 'resume': {
        if (!cmd.args) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /resume &lt;session-id&gt;</blockquote>', 'HTML');
          break;
        }
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        this.sessionStore.setCurrentSession(agentId, cmd.userId, cmd.args.trim());
        await agent.tgBot.sendText(cmd.chatId, `Will resume session <code>${escapeHtml(cmd.args.trim().slice(0, 8))}</code> on next message.`, 'HTML');
        break;
      }

      case 'session': {
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const session = userState.sessions.find(s => s.id === userState.currentSessionId);
        if (!session) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active session.</blockquote>', 'HTML');
          break;
        }
        await agent.tgBot.sendText(cmd.chatId,
          `<b>Session:</b> <code>${escapeHtml(session.id.slice(0, 8))}</code>\n<b>Messages:</b> ${session.messageCount}\n<b>Cost:</b> $${session.totalCostUsd.toFixed(4)}\n<b>Started:</b> ${session.startedAt}`,
          'HTML'
        );
        break;
      }

      case 'model': {
        const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];
        if (!cmd.args) {
          const current = this.sessionStore.getUser(agentId, cmd.userId).model
            || resolveUserConfig(agent.config, cmd.userId).model;
          const keyboard = new InlineKeyboard();
          for (const m of MODEL_OPTIONS) {
            const isCurrent = current.includes(m);
            keyboard.text(isCurrent ? `${m} ✓` : m, `model:${m}`);
          }
          keyboard.row().text('Custom…', `model:custom`);
          await agent.tgBot.sendTextWithKeyboard(
            cmd.chatId,
            `<b>Current model:</b> <code>${escapeHtml(current)}</code>`,
            keyboard,
            'HTML',
          );
          break;
        }
        this.sessionStore.setModel(agentId, cmd.userId, cmd.args.trim());
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        await agent.tgBot.sendText(cmd.chatId, `Model set to <code>${escapeHtml(cmd.args.trim())}</code>. Process respawned.`, 'HTML');
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
            await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /repo add &lt;name&gt; &lt;path&gt;</blockquote>', 'HTML');
            break;
          }
          if (!isValidRepoName(repoName)) {
            await agent.tgBot.sendText(cmd.chatId, '<blockquote>Invalid repo name. Use alphanumeric + hyphens only.</blockquote>', 'HTML');
            break;
          }
          if (!existsSync(repoAddPath)) {
            await agent.tgBot.sendText(cmd.chatId, `Path not found: <code>${escapeHtml(repoAddPath)}</code>`, 'HTML');
            break;
          }
          if (this.config.repos[repoName]) {
            await agent.tgBot.sendText(cmd.chatId, `Repo <code>${escapeHtml(repoName)}</code> already exists.`, 'HTML');
            break;
          }
          updateConfig((cfg) => {
            const repos = (cfg.repos ?? {}) as Record<string, string>;
            repos[repoName] = repoAddPath;
            cfg.repos = repos;
          });
          await agent.tgBot.sendText(cmd.chatId, `Repo <code>${escapeHtml(repoName)}</code> added → ${escapeHtml(repoAddPath)}`, 'HTML');
          break;
        }

        if (repoSub === 'remove') {
          // /repo remove <name>
          const repoName = repoArgs[1];
          if (!repoName) {
            await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /repo remove &lt;name&gt;</blockquote>', 'HTML');
            break;
          }
          if (!this.config.repos[repoName]) {
            await agent.tgBot.sendText(cmd.chatId, `Repo <code>${escapeHtml(repoName)}</code> not found.`, 'HTML');
            break;
          }
          // Check if any agent has it assigned
          const rawCfg = JSON.parse(readFileSync(join(homedir(), '.tgcc', 'config.json'), 'utf-8'));
          const owner = findRepoOwner(rawCfg, repoName);
          if (owner) {
            await agent.tgBot.sendText(cmd.chatId, `Can't remove: repo <code>${escapeHtml(repoName)}</code> is assigned to agent <code>${escapeHtml(owner)}</code>. Use /repo clear on that agent first.`, 'HTML');
            break;
          }
          updateConfig((cfg) => {
            const repos = (cfg.repos ?? {}) as Record<string, string>;
            delete repos[repoName];
            cfg.repos = repos;
          });
          await agent.tgBot.sendText(cmd.chatId, `Repo <code>${escapeHtml(repoName)}</code> removed.`, 'HTML');
          break;
        }

        if (repoSub === 'assign') {
          // /repo assign <name> — assign to THIS agent
          const repoName = repoArgs[1];
          if (!repoName) {
            await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /repo assign &lt;name&gt;</blockquote>', 'HTML');
            break;
          }
          if (!this.config.repos[repoName]) {
            await agent.tgBot.sendText(cmd.chatId, `Repo <code>${escapeHtml(repoName)}</code> not found in registry.`, 'HTML');
            break;
          }
          const rawCfg2 = JSON.parse(readFileSync(join(homedir(), '.tgcc', 'config.json'), 'utf-8'));
          const existingOwner = findRepoOwner(rawCfg2, repoName);
          if (existingOwner && existingOwner !== agentId) {
            await agent.tgBot.sendText(cmd.chatId, `Repo <code>${escapeHtml(repoName)}</code> is already assigned to agent <code>${escapeHtml(existingOwner)}</code>.`, 'HTML');
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
          await agent.tgBot.sendText(cmd.chatId, `Repo <code>${escapeHtml(repoName)}</code> assigned to agent <code>${escapeHtml(agentId)}</code>.`, 'HTML');
          break;
        }

        if (repoSub === 'help') {
          const helpText = [
            '<b>Repo Management</b>',
            '',
            '/repo — List repos (buttons)',
            '/repo help — This help text',
            '/repo add &lt;name&gt; &lt;path&gt; — Register a repo',
            '/repo remove &lt;name&gt; — Unregister a repo',
            '/repo assign &lt;name&gt; — Set as this agent\'s default',
            '/repo clear — Clear this agent\'s default',
          ].join('\n');
          await agent.tgBot.sendText(cmd.chatId, helpText, 'HTML');
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
          await agent.tgBot.sendText(cmd.chatId, `Default repo cleared for agent <code>${escapeHtml(agentId)}</code>.`, 'HTML');
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
              `Current repo: <code>${escapeHtml(current)}</code>\n\nSelect a repo:\n\n<i>Type /repo help for management commands</i>`,
              keyboard,
              'HTML',
            );
          } else {
            await agent.tgBot.sendText(cmd.chatId, `<b>Current repo:</b> <code>${escapeHtml(current)}</code>\n\nUsage: /repo &lt;path&gt;`, 'HTML');
          }
          break;
        }

        // Fallback: /repo <path-or-name> — switch working directory for session
        const repoPath = resolveRepoPath(this.config.repos, cmd.args.trim());
        if (!existsSync(repoPath)) {
          await agent.tgBot.sendText(cmd.chatId, `Path not found: <code>${escapeHtml(repoPath)}</code>`, 'HTML');
          break;
        }
        // Kill current process (different CWD needs new process)
        const proc = agent.processes.get(cmd.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(cmd.userId);
        }
        this.sessionStore.setRepo(agentId, cmd.userId, repoPath);
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const lastActive = new Date(userState.lastActivity).getTime();
        const staleMs = 24 * 60 * 60 * 1000;
        if (Date.now() - lastActive > staleMs || !userState.currentSessionId) {
          this.sessionStore.clearSession(agentId, cmd.userId);
          await agent.tgBot.sendText(cmd.chatId, `Repo set to <code>${escapeHtml(repoPath)}</code>. Session cleared (stale).`, 'HTML');
        } else {
          await agent.tgBot.sendText(cmd.chatId, `Repo set to <code>${escapeHtml(repoPath)}</code>. Session kept (active &lt;24h).`, 'HTML');
        }
        break;
      }

      case 'cancel': {
        const proc = agent.processes.get(cmd.userId);
        if (proc && proc.state === 'active') {
          proc.cancel();
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Cancelled.</blockquote>', 'HTML');
        } else {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active turn to cancel.</blockquote>', 'HTML');
        }
        break;
      }

      case 'catchup': {
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const repo = userState.repo || resolveUserConfig(agent.config, cmd.userId).repo;
        const lastActivity = new Date(userState.lastActivity || 0);
        const missed = findMissedSessions(repo, userState.knownSessionIds, lastActivity);
        const message = formatCatchupMessage(repo, missed);
        await agent.tgBot.sendText(cmd.chatId, message, 'HTML');
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
            await agent.tgBot.sendText(cmd.chatId, `<blockquote>Invalid mode. Valid: ${validModes.join(', ')}</blockquote>`, 'HTML');
            break;
          }
          this.sessionStore.setPermissionMode(agentId, cmd.userId, mode);
          // Kill current process so new mode takes effect on next spawn
          const proc = agent.processes.get(cmd.userId);
          if (proc) {
            proc.destroy();
            agent.processes.delete(cmd.userId);
          }
          await agent.tgBot.sendText(cmd.chatId, `Permission mode set to <code>${escapeHtml(mode)}</code>. Takes effect on next message.`, 'HTML');
          break;
        }

        // No args — show current mode + inline keyboard
        const keyboard = new InlineKeyboard();
        keyboard.text('🔓 Bypass', 'permissions:dangerously-skip').text('✏️ Accept Edits', 'permissions:acceptEdits').row();
        keyboard.text('🔒 Default', 'permissions:default').text('📋 Plan', 'permissions:plan').row();

        await agent.tgBot.sendTextWithKeyboard(
          cmd.chatId,
          `Current: <code>${escapeHtml(currentMode)}</code>\nDefault: <code>${escapeHtml(agentDefault)}</code>\n\nSelect a mode for this session:`,
          keyboard,
          'HTML',
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
          `Will resume session <code>${escapeHtml(sessionId.slice(0, 8))}</code> on next message.`,
          'HTML',
        );
        break;
      }

      case 'delete': {
        const sessionId = query.data;
        const deleted = this.sessionStore.deleteSession(agentId, query.userId, sessionId);
        if (deleted) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Session deleted');
          await agent.tgBot.sendText(query.chatId, `Session <code>${escapeHtml(sessionId.slice(0, 8))}</code> deleted.`, 'HTML');
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
        const userState2 = this.sessionStore.getUser(agentId, query.userId);
        const lastActive2 = new Date(userState2.lastActivity).getTime();
        const staleMs2 = 24 * 60 * 60 * 1000;
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Repo: ${repoName}`);
        if (Date.now() - lastActive2 > staleMs2 || !userState2.currentSessionId) {
          this.sessionStore.clearSession(agentId, query.userId);
          await agent.tgBot.sendText(query.chatId, `Repo set to <code>${escapeHtml(repoPath)}</code>. Session cleared (stale).`, 'HTML');
        } else {
          await agent.tgBot.sendText(query.chatId, `Repo set to <code>${escapeHtml(repoPath)}</code>. Session kept (active &lt;24h).`, 'HTML');
        }
        break;
      }

      case 'repo_add': {
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Usage below');
        await agent.tgBot.sendText(query.chatId, 'Send: <code>/repo add &lt;name&gt; &lt;path&gt;</code>', 'HTML');
        break;
      }

      case 'model': {
        const model = query.data;
        if (model === 'custom') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Usage below');
          await agent.tgBot.sendText(query.chatId, 'Send: <code>/model &lt;model-name&gt;</code>', 'HTML');
          break;
        }
        this.sessionStore.setModel(agentId, query.userId, model);
        const proc = agent.processes.get(query.userId);
        if (proc) {
          proc.destroy();
          agent.processes.delete(query.userId);
        }
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Model: ${model}`);
        await agent.tgBot.sendText(query.chatId, `Model set to <code>${escapeHtml(model)}</code>. Process respawned.`, 'HTML');
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
          `Permission mode set to <code>${escapeHtml(mode)}</code>. Takes effect on next message.`,
          'HTML',
        );
        break;
      }

      case 'repo_help': {
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId);
        const helpText = [
          '<b>Repo Management</b>',
          '',
          '/repo — List repos (buttons)',
          '/repo help — This help text',
          '/repo add &lt;name&gt; &lt;path&gt; — Register a repo',
          '/repo remove &lt;name&gt; — Unregister a repo',
          '/repo assign &lt;name&gt; — Set as this agent\'s default',
          '/repo clear — Clear this agent\'s default',
        ].join('\n');
        await agent.tgBot.sendText(query.chatId, helpText, 'HTML');
        break;
      }

      case 'perm_allow': {
        const requestId = query.data;
        const pending = agent.pendingPermissions.get(requestId);
        if (!pending) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Permission expired');
          break;
        }
        const proc = agent.processes.get(pending.userId);
        if (proc) {
          proc.respondToPermission(requestId, true);
        }
        agent.pendingPermissions.delete(requestId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '✅ Allowed');
        break;
      }

      case 'perm_deny': {
        const requestId = query.data;
        const pending = agent.pendingPermissions.get(requestId);
        if (!pending) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Permission expired');
          break;
        }
        const proc = agent.processes.get(pending.userId);
        if (proc) {
          proc.respondToPermission(requestId, false);
        }
        agent.pendingPermissions.delete(requestId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '❌ Denied');
        break;
      }

      case 'perm_allow_all': {
        // Allow all pending permissions for this user
        const targetUserId = query.data;
        const toAllow: string[] = [];
        for (const [reqId, pending] of agent.pendingPermissions) {
          if (pending.userId === targetUserId) {
            toAllow.push(reqId);
          }
        }
        const proc = agent.processes.get(targetUserId);
        for (const reqId of toAllow) {
          if (proc) proc.respondToPermission(reqId, true);
          agent.pendingPermissions.delete(reqId);
        }
        await agent.tgBot.answerCallbackQuery(
          query.callbackQueryId,
          `✅ Allowed ${toAllow.length} permission(s)`,
        );
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
    this.removeAllListeners();
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

/** Environment-aware MCP server path resolution */
function resolveMcpServerPath(): string {
  const baseDir = import.meta.dirname ?? '.';

  // Check for compiled JS first (production/tsx runtime)
  const jsPath = join(baseDir, 'mcp-server.js');
  if (existsSync(jsPath)) {
    return jsPath;
  }

  // Fallback to TS source (development)
  return join(baseDir, 'mcp-server.ts');
}

