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
import type { ApiErrorEvent, PermissionRequest, ToolResultEvent, TaskStartedEvent, TaskProgressEvent, TaskCompletedEvent, CompactBoundaryEvent } from './cc-protocol.js';
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
import { StreamAccumulator, SubAgentTracker, escapeHtml, formatSystemMessage, type TelegramSender, type SubAgentSender } from './streaming.js';
import { TelegramBot, type TelegramMessage, type SlashCommand, type CallbackQuery } from './telegram.js';
import { InlineKeyboard } from 'grammy';
import { McpBridgeServer, type McpToolRequest, type McpToolResponse } from './mcp-bridge.js';
import {
  SessionStore,
  discoverCCSessions,
} from './session.js';
import {
  CtlServer,
  type CtlHandler,
  type CtlAckResponse,
  type CtlStatusResponse,
} from './ctl-server.js';
import { ProcessRegistry, type ClientRef, type ProcessEntry } from './process-registry.js';

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
  repo: string;                            // resolved repo path (from config or /repo command)
  model: string;                           // resolved model (from config or /model command)
  ccProcess: CCProcess | null;             // single CC process per agent
  accumulator: StreamAccumulator | null;   // single accumulator per agent
  subAgentTracker: SubAgentTracker | null; // single tracker per agent
  batcher: MessageBatcher | null;          // single batcher per agent
  pendingPermissions: Map<string, PendingPermission>; // requestId → pending permission
  typingInterval: ReturnType<typeof setInterval> | null; // single typing interval
  typingChatId: number | null;             // chat currently showing typing indicator
  pendingSessionId: string | null;         // for /resume: sessionId to use on next spawn
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
/compact [instructions] — Compact conversation context
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
  private processRegistry = new ProcessRegistry();
  private mcpServer: McpBridgeServer;
  private ctlServer: CtlServer;
  private sessionStore: SessionStore;
  private logger: pino.Logger;

  // Supervisor protocol
  private supervisorWrite: ((line: string) => void) | null = null;
  private supervisorAgentId: string | null = null;
  private supervisorSubscriptions = new Set<string>(); // "agentId:sessionId" or "agentId:*"
  private suppressExitForProcess = new Set<string>(); // sessionIds where takeover suppresses exit event

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

    // Resolve initial repo and model from config + persisted state
    const agentState = this.sessionStore.getAgent(agentId);
    const configDefaults = agentConfig.defaults;

    const instance: AgentInstance = {
      id: agentId,
      config: agentConfig,
      tgBot,
      repo: agentState.repo || configDefaults.repo,
      model: agentState.model || configDefaults.model,
      ccProcess: null,
      accumulator: null,
      subAgentTracker: null,
      batcher: null,
      pendingPermissions: new Map(),
      typingInterval: null,
      typingChatId: null,
      pendingSessionId: null,
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

    // Kill CC process if active
    if (agent.ccProcess) {
      const proc = agent.ccProcess;
      const exitPromise = new Promise<void>((resolve) => {
        const onExit = () => {
          proc.off('exit', onExit);
          resolve();
        };
        proc.on('exit', onExit);
        const timeoutId = setTimeout(() => {
          proc.off('exit', onExit);
          resolve();
        }, 3000);
        proc.on('exit', () => clearTimeout(timeoutId));
      });
      proc.destroy();
      await exitPromise;

      // Unsubscribe from registry
      const clientRef: ClientRef = { agentId, userId: agentId, chatId: 0 };
      this.processRegistry.unsubscribe(clientRef);
    }

    // Cancel batcher
    if (agent.batcher) {
      agent.batcher.cancel();
      agent.batcher.destroy();
    }

    // Close MCP socket
    const socketPath = join(this.config.global.socketDir, `${agentId}.sock`);
    this.mcpServer.close(socketPath);

    // Clean up accumulator
    if (agent.accumulator) {
      agent.accumulator.finalize();
      agent.accumulator = null;
    }

    // Clean up sub-agent tracker
    if (agent.subAgentTracker) {
      agent.subAgentTracker.reset();
      agent.subAgentTracker = null;
    }

    // Clear typing indicator
    if (agent.typingInterval) {
      clearInterval(agent.typingInterval);
      agent.typingInterval = null;
    }

    agent.pendingPermissions.clear();
    agent.ccProcess = null;
    agent.batcher = null;

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

    // Ensure batcher exists (one per agent, not per user)
    if (!agent.batcher) {
      agent.batcher = new MessageBatcher(2000, (combined) => {
        this.sendToCC(agentId, combined, { chatId: msg.chatId });
      });
    }

    // Prepare text with reply context
    let text = msg.text;
    if (msg.replyToText) {
      text = `[Replying to: '${msg.replyToText}']\n\n${text}`;
    }

    agent.batcher.add({
      text,
      imageBase64: msg.imageBase64,
      imageMediaType: msg.imageMediaType,
      filePath: msg.filePath,
      fileName: msg.fileName,
    });
  }

  private sendToCC(
    agentId: string,
    data: { text: string; imageBase64?: string; imageMediaType?: string; filePath?: string; fileName?: string },
    source?: { chatId?: number }
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

    let proc = agent.ccProcess;

    if (proc?.takenOver) {
      // Session was taken over externally — discard old process
      const entry = this.processRegistry.findByProcess(proc);
      if (entry) this.processRegistry.destroy(entry.repo, entry.sessionId);
      agent.ccProcess = null;
      proc = null;
    }

    if (!proc || proc.state === 'idle') {
      // Warn if no repo is configured
      if (agent.repo === homedir()) {
        const chatId = source?.chatId;
        if (chatId) {
          agent.tgBot.sendText(
            chatId,
            formatSystemMessage('status', 'No project selected. Use /repo to pick one, or CC will run in your home directory.'),
            'HTML',
          ).catch(err => this.logger.error({ err }, 'Failed to send no-repo warning'));
        }
      }

      proc = this.spawnCCProcess(agentId);
      agent.ccProcess = proc;
    }

    // Show typing indicator
    if (source?.chatId) {
      this.startTypingIndicator(agent, source.chatId);
    }

    proc.sendMessage(ccMsg);
  }

  // ── Process cleanup helper ──

  /**
   * Kill the agent's CC process and clean up.
   */
  private killAgentProcess(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const proc = agent.ccProcess;
    if (proc) {
      const entry = this.processRegistry.findByProcess(proc);
      if (entry) {
        this.processRegistry.destroy(entry.repo, entry.sessionId);
      } else {
        proc.destroy();
      }
    }
    agent.ccProcess = null;

    // Clean up accumulator & tracker
    if (agent.accumulator) {
      agent.accumulator.finalize();
      agent.accumulator = null;
    }
    if (agent.subAgentTracker) {
      agent.subAgentTracker.reset();
      agent.subAgentTracker = null;
    }
    this.stopTypingIndicator(agent);
  }

  // ── Typing indicator management ──

  /** Get the primary TG chat ID for an agent (first allowed user). */
  private getAgentChatId(agent: AgentInstance): number | null {
    // If we have a typing chatId, use that (most recent active chat)
    if (agent.typingChatId) return agent.typingChatId;
    // Fall back to first allowed user
    const firstUser = agent.config.allowedUsers[0];
    return firstUser ? Number(firstUser) : null;
  }

  private startTypingIndicator(agent: AgentInstance, chatId: number): void {
    // Don't create duplicate intervals
    if (agent.typingInterval) return;
    agent.typingChatId = chatId;
    // Send immediately, then repeat every 4s (TG typing badge lasts ~5s)
    agent.tgBot.sendTyping(chatId);
    const interval = setInterval(() => {
      if (agent.typingChatId) agent.tgBot.sendTyping(agent.typingChatId);
    }, 4_000);
    agent.typingInterval = interval;
  }

  private stopTypingIndicator(agent: AgentInstance): void {
    if (agent.typingInterval) {
      clearInterval(agent.typingInterval);
      agent.typingInterval = null;
      agent.typingChatId = null;
    }
  }

  private spawnCCProcess(agentId: string): CCProcess {
    const agent = this.agents.get(agentId)!;
    const agentState = this.sessionStore.getAgent(agentId);

    // Build userConfig from agent-level state
    const userConfig = resolveUserConfig(agent.config, agent.config.allowedUsers[0] || 'default');
    userConfig.repo = agent.repo;
    userConfig.model = agent.model;
    if (agentState.permissionMode) {
      userConfig.permissionMode = agentState.permissionMode as typeof userConfig.permissionMode;
    }

    // Determine session ID: pending from /resume, or let CC create new
    const sessionId = agent.pendingSessionId ?? undefined;
    agent.pendingSessionId = null; // consumed

    // Generate MCP config (use agentId as the "userId" for socket naming)
    const mcpServerPath = resolveMcpServerPath();
    const mcpConfigPath = generateMcpConfig(
      agentId,
      agentId, // single socket per agent
      this.config.global.socketDir,
      mcpServerPath,
    );

    // Start MCP socket listener for this agent
    const socketPath = join(this.config.global.socketDir, `${agentId}-${agentId}.sock`);
    this.mcpServer.listen(socketPath);

    const proc = new CCProcess({
      agentId,
      userId: agentId, // agent is the sole "user"
      ccBinaryPath: this.config.global.ccBinaryPath,
      userConfig,
      mcpConfigPath,
      sessionId,
      continueSession: !!sessionId,
      logger: this.logger,
    });

    // Register in the process registry
    const ownerRef: ClientRef = { agentId, userId: agentId, chatId: 0 };
    const tentativeSessionId = sessionId ?? `pending-${Date.now()}`;
    const registryEntry = this.processRegistry.register(
      userConfig.repo,
      tentativeSessionId,
      userConfig.model || 'default',
      proc,
      ownerRef,
    );

    // ── Helper: get all subscribers for this process from the registry ──
    const getEntry = (): ProcessEntry | null => this.processRegistry.findByProcess(proc);

    // ── Wire up event handlers (broadcast to all subscribers) ──

    proc.on('init', (event: InitEvent) => {
      this.sessionStore.updateLastActivity(agentId);

      // Update registry key if session ID changed from tentative
      if (event.session_id !== tentativeSessionId) {
        const entry = getEntry();
        if (entry) {
          this.processRegistry.remove(userConfig.repo, tentativeSessionId);
          this.processRegistry.register(userConfig.repo, event.session_id, userConfig.model || 'default', proc, ownerRef);
        }
      }
    });

    proc.on('stream_event', (event: StreamInnerEvent) => {
      this.handleStreamEvent(agentId, event);
    });

    proc.on('tool_result', (event: ToolResultEvent) => {
      // Resolve tool indicator message with success/failure status
      const acc = agent.accumulator;
      if (acc && event.tool_use_id) {
        const isError = event.is_error === true;
        const contentStr = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
        const errorMsg = isError ? contentStr : undefined;
        acc.resolveToolMessage(event.tool_use_id, isError, errorMsg, contentStr, event.tool_use_result);
      }

      const tracker = agent.subAgentTracker;
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
            if (proc.state === 'active') {
              proc.sendMessage(createTextMessage(
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
      if (agent.subAgentTracker) {
        agent.subAgentTracker.handleTaskStarted(event.tool_use_id, event.description, event.task_type);
      }
    });

    proc.on('task_progress', (event: TaskProgressEvent) => {
      if (agent.subAgentTracker) {
        agent.subAgentTracker.handleTaskProgress(event.tool_use_id, event.description, event.last_tool_name);
      }
    });

    proc.on('task_completed', (event: TaskCompletedEvent) => {
      if (agent.subAgentTracker) {
        agent.subAgentTracker.handleTaskCompleted(event.tool_use_id);
      }
    });

    // Media from tool results (images, PDFs, etc.)
    proc.on('media', (media: { kind: string; media_type: string; data: string }) => {
      const buf = Buffer.from(media.data, 'base64');
      const chatId = this.getAgentChatId(agent);
      if (!chatId) return;
      if (media.kind === 'image') {
        agent.tgBot.sendPhotoBuffer(chatId, buf).catch(err => {
          this.logger.error({ err, agentId }, 'Failed to send tool_result image');
        });
      } else if (media.kind === 'document') {
        const ext = media.media_type === 'application/pdf' ? '.pdf' : '';
        agent.tgBot.sendDocumentBuffer(chatId, buf, `document${ext}`).catch(err => {
          this.logger.error({ err, agentId }, 'Failed to send tool_result document');
        });
      }
    });

    proc.on('assistant', (event: AssistantMessage) => {
      // Non-streaming fallback — only used if stream_events don't fire
      // In practice, stream_events handle the display
    });

    proc.on('result', (event: ResultEvent) => {
      this.stopTypingIndicator(agent);
      this.handleResult(agentId, event);

      // Forward to supervisor
      if (this.isSupervisorSubscribed(agentId, proc.sessionId)) {
        const resultText = event.result ? String(event.result) : '';
        this.sendToSupervisor({
          type: 'event',
          event: 'result',
          agentId,
          sessionId: proc.sessionId,
          text: resultText,
          is_error: event.is_error ?? false,
        });
      }
    });

    proc.on('compact', (event: CompactBoundaryEvent) => {
      const trigger = event.compact_metadata?.trigger ?? 'manual';
      const preTokens = event.compact_metadata?.pre_tokens;
      const tokenInfo = preTokens ? ` (was ${Math.round(preTokens / 1000)}k tokens)` : '';
      const label = trigger === 'auto' ? '🗜️ Auto-compacted' : '🗜️ Compacted';
      const chatId = this.getAgentChatId(agent);
      if (chatId) {
        agent.tgBot.sendText(
          chatId,
          `<blockquote>${escapeHtml(label + tokenInfo)}</blockquote>`,
          'HTML'
        ).catch((err: Error) => this.logger.error({ err }, 'Failed to send compact notification'));
      }
    });

    proc.on('permission_request', (event: PermissionRequest) => {
      const req = event.request;
      const requestId = event.request_id;

      agent.pendingPermissions.set(requestId, {
        requestId,
        userId: agentId,
        toolName: req.tool_name,
        input: req.input,
      });

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
        .text('✅ Allow All', `perm_allow_all:${agentId}`);

      const permChatId = this.getAgentChatId(agent);
      if (permChatId) {
        agent.tgBot.sendTextWithKeyboard(permChatId, text, keyboard, 'HTML')
          .catch(err => this.logger.error({ err }, 'Failed to send permission request'));
      }
    });

    proc.on('api_error', (event: ApiErrorEvent) => {
      const errMsg = event.error?.message || 'Unknown API error';
      const status = event.error?.status;
      const isOverloaded = status === 529 || errMsg.includes('overloaded');
      const retryInfo = event.retryAttempt != null && event.maxRetries != null
        ? ` (retry ${event.retryAttempt}/${event.maxRetries})`
        : '';

      const text = isOverloaded
        ? formatSystemMessage('error', `API overloaded, retrying...${retryInfo}`)
        : formatSystemMessage('error', `${escapeHtml(errMsg)}${retryInfo}`);

      const errChatId = this.getAgentChatId(agent);
      if (errChatId) {
        agent.tgBot.sendText(errChatId, text, 'HTML')
          .catch(err => this.logger.error({ err }, 'Failed to send API error notification'));
      }
    });

    proc.on('hang', () => {
      this.stopTypingIndicator(agent);
      const hangChatId = this.getAgentChatId(agent);
      if (hangChatId) {
        agent.tgBot.sendText(hangChatId, '<blockquote>⏸ Session paused. Send a message to continue.</blockquote>', 'HTML')
          .catch(err => this.logger.error({ err }, 'Failed to send hang notification'));
      }
    });

    proc.on('takeover', () => {
      this.logger.warn({ agentId }, 'Session takeover detected — keeping session for roaming');

      // Notify supervisor and suppress subsequent exit event
      if (this.isSupervisorSubscribed(agentId, proc.sessionId)) {
        this.sendToSupervisor({ type: 'event', event: 'session_takeover', agentId, sessionId: proc.sessionId });
        this.suppressExitForProcess.add(proc.sessionId ?? '');
      }

      this.stopTypingIndicator(agent);
      const entry = getEntry();
      if (entry) {
        this.processRegistry.remove(entry.repo, entry.sessionId);
      }
      agent.ccProcess = null;
      proc.destroy();
    });

    proc.on('exit', () => {
      // Forward to supervisor (unless suppressed by takeover)
      if (this.suppressExitForProcess.has(proc.sessionId ?? '')) {
        this.suppressExitForProcess.delete(proc.sessionId ?? '');
      } else if (this.isSupervisorSubscribed(agentId, proc.sessionId)) {
        this.sendToSupervisor({ type: 'event', event: 'process_exit', agentId, sessionId: proc.sessionId, exitCode: null });
      }

      this.stopTypingIndicator(agent);

      if (agent.accumulator) {
        agent.accumulator.finalize();
        agent.accumulator = null;
      }
      if (agent.subAgentTracker) {
        agent.subAgentTracker.stopMailboxWatch();
        agent.subAgentTracker = null;
      }

      const entry = getEntry();
      if (entry) {
        this.processRegistry.remove(entry.repo, entry.sessionId);
      }
      agent.ccProcess = null;
    });

    proc.on('error', (err: Error) => {
      this.stopTypingIndicator(agent);
      const errChatId = this.getAgentChatId(agent);
      if (errChatId) {
        agent.tgBot.sendText(errChatId, formatSystemMessage('error', escapeHtml(String(err.message))), 'HTML')
          .catch(err2 => this.logger.error({ err: err2 }, 'Failed to send process error notification'));
      }
    });

    return proc;
  }

  // ── Stream event handling ──

  private handleStreamEvent(agentId: string, event: StreamInnerEvent): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const chatId = this.getAgentChatId(agent);
    if (!chatId) return;

    if (!agent.accumulator) {
      const sender: TelegramSender = {
        sendMessage: (cid, text, parseMode) => {
          this.logger.info({ agentId, chatId: cid, textLen: text.length }, 'TG accumulator sendMessage');
          return agent.tgBot.sendText(cid, text, parseMode);
        },
        editMessage: (cid, msgId, text, parseMode) => {
          this.logger.info({ agentId, chatId: cid, msgId, textLen: text.length }, 'TG accumulator editMessage');
          return agent.tgBot.editText(cid, msgId, text, parseMode);
        },
        deleteMessage: (cid, msgId) => agent.tgBot.deleteMessage(cid, msgId),
        sendPhoto: (cid, buffer, caption) => agent.tgBot.sendPhotoBuffer(cid, buffer, caption),
      };
      const onError = (err: unknown, context: string) => {
        this.logger.error({ err, context, agentId }, 'Stream accumulator error');
        agent.tgBot.sendText(chatId, formatSystemMessage('error', escapeHtml(context)), 'HTML').catch(() => {});
      };
      agent.accumulator = new StreamAccumulator({ chatId, sender, logger: this.logger, onError });
    }

    if (!agent.subAgentTracker) {
      const subAgentSender: SubAgentSender = {
        sendMessage: (cid, text, parseMode) =>
          agent.tgBot.sendText(cid, text, parseMode),
        editMessage: (cid, msgId, text, parseMode) =>
          agent.tgBot.editText(cid, msgId, text, parseMode),
        setReaction: (cid, msgId, emoji) =>
          agent.tgBot.setReaction(cid, msgId, emoji),
      };
      agent.subAgentTracker = new SubAgentTracker({
        chatId,
        sender: subAgentSender,
      });
    }

    // On message_start: new CC turn — full reset for text accumulator.
    if (event.type === 'message_start') {
      agent.accumulator.reset();
      if (!agent.subAgentTracker.hasDispatchedAgents) {
        agent.subAgentTracker.reset();
      }
    }

    agent.accumulator.handleEvent(event);
    agent.subAgentTracker.handleEvent(event);
  }

  private handleResult(agentId: string, event: ResultEvent): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const chatId = this.getAgentChatId(agent);

    // Set usage stats on the accumulator before finalizing
    const acc = agent.accumulator;
    if (acc) {
      if (event.usage) {
        const proc = agent.ccProcess;
        const entry = proc ? this.processRegistry.findByProcess(proc) : null;
        acc.setTurnUsage({
          inputTokens: event.usage.input_tokens ?? 0,
          outputTokens: event.usage.output_tokens ?? 0,
          cacheReadTokens: event.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: event.usage.cache_creation_input_tokens ?? 0,
          costUsd: event.total_cost_usd ?? null,
          model: (event as { model?: string }).model ?? entry?.model,
        });
      }
      acc.finalize();
    }

    // Handle errors
    if (event.is_error && event.result && chatId) {
      agent.tgBot.sendText(chatId, formatSystemMessage('error', escapeHtml(String(event.result))), 'HTML')
        .catch(err => this.logger.error({ err }, 'Failed to send result error notification'));
    }

    // If background sub-agents are still running, mailbox watcher handles them.
    const tracker = agent.subAgentTracker;
    if (tracker?.hasDispatchedAgents && tracker.currentTeamName) {
      this.logger.info({ agentId }, 'Turn ended with background sub-agents still running');
      const ccProcess = agent.ccProcess;
      if (ccProcess) ccProcess.clearIdleTimer();
      // Start mailbox watcher (works for general-purpose agents that have SendMessage)
      tracker.startMailboxWatch();
      // Fallback: send ONE follow-up after 60s if mailbox hasn't resolved all agents
      // This handles bash-type agents that can't write to mailbox
      if (!tracker.hasPendingFollowUp) {
        tracker.hasPendingFollowUp = true;
        setTimeout(() => {
          if (!tracker.hasDispatchedAgents) return;
          const proc = agent.ccProcess;
          if (!proc) return;
          this.logger.info({ agentId }, 'Mailbox timeout — sending single follow-up for remaining agents');
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
        const repo = agent.repo;
        const model = agent.model;
        const session = agent.ccProcess?.sessionId;
        const lines = ['👋 <b>TGCC</b> — Telegram ↔ Claude Code bridge'];
        if (repo) lines.push(`📂 <code>${escapeHtml(shortenRepoPath(repo))}</code>`);
        if (model) lines.push(`🤖 ${escapeHtml(model)}`);
        if (session) lines.push(`📎 Session: <code>${escapeHtml(session.slice(0, 8))}</code>`);
        lines.push('', 'Send a message to start, or use /help for commands.');
        await agent.tgBot.sendText(cmd.chatId, lines.join('\n'), 'HTML');
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
        const state = agent.ccProcess?.state ?? 'idle';
        await agent.tgBot.sendText(cmd.chatId, `pong — process: <b>${state.toUpperCase()}</b>`, 'HTML');
        break;
      }

      case 'status': {
        const proc = agent.ccProcess;
        const uptime = proc?.spawnedAt
          ? formatDuration(Date.now() - proc.spawnedAt.getTime())
          : 'N/A';

        const status = [
          `<b>Agent:</b> ${escapeHtml(agentId)}`,
          `<b>Process:</b> ${(proc?.state ?? 'idle').toUpperCase()} (uptime: ${uptime})`,
          `<b>Session:</b> <code>${escapeHtml(proc?.sessionId?.slice(0, 8) ?? 'none')}</code>`,
          `<b>Model:</b> ${escapeHtml(agent.model)}`,
          `<b>Repo:</b> ${escapeHtml(agent.repo)}`,
          `<b>Cost:</b> $${(proc?.totalCostUsd ?? 0).toFixed(4)}`,
        ].join('\n');
        await agent.tgBot.sendText(cmd.chatId, status, 'HTML');
        break;
      }

      case 'cost': {
        await agent.tgBot.sendText(cmd.chatId, `<b>Session cost:</b> $${(agent.ccProcess?.totalCostUsd ?? 0).toFixed(4)}`, 'HTML');
        break;
      }

      case 'new': {
        this.killAgentProcess(agentId);
        agent.pendingSessionId = null; // next message spawns fresh
        const newLines = ['Session cleared. Next message starts fresh.'];
        if (agent.repo) newLines.push(`📂 <code>${escapeHtml(shortenRepoPath(agent.repo))}</code>`);
        if (agent.model) newLines.push(`🤖 ${escapeHtml(agent.model)}`);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>${newLines.join('\n')}</blockquote>`, 'HTML');
        break;
      }

      case 'continue': {
        // Remember the current session before killing
        const contSession = agent.ccProcess?.sessionId;
        this.killAgentProcess(agentId);

        // If no session, auto-pick the most recent one
        let sessionToResume = contSession;
        if (!sessionToResume && agent.repo) {
          const recent = discoverCCSessions(agent.repo, 1);
          if (recent.length > 0) {
            sessionToResume = recent[0].id;
          }
        }
        if (sessionToResume) {
          agent.pendingSessionId = sessionToResume;
        }

        const contLines = ['Process respawned. Session kept.'];
        if (agent.repo) contLines.push(`📂 <code>${escapeHtml(shortenRepoPath(agent.repo))}</code>`);
        if (agent.model) contLines.push(`🤖 ${escapeHtml(agent.model)}`);
        if (sessionToResume) contLines.push(`📎 <code>${escapeHtml(sessionToResume.slice(0, 8))}</code>`);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>${contLines.join('\n')}</blockquote>`, 'HTML');
        break;
      }

      case 'sessions': {
        const repo = agent.repo;
        const currentSessionId = agent.ccProcess?.sessionId ?? null;

        // Discover sessions from CC's session directory
        const discovered = repo ? discoverCCSessions(repo, 5) : [];

        type MergedSession = { id: string; title: string; age: string; detail: string; isCurrent: boolean };
        const merged: MergedSession[] = discovered.map(d => {
          const ctx = d.contextPct !== null ? ` · ${d.contextPct}% ctx` : '';
          const modelTag = d.model ? ` · ${shortModel(d.model)}` : '';
          return {
            id: d.id,
            title: d.title,
            age: formatAge(d.mtime),
            detail: `~${d.lineCount} entries${ctx}${modelTag}`,
            isCurrent: d.id === currentSessionId,
          };
        });

        if (merged.length === 0) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No sessions found.</blockquote>', 'HTML');
          break;
        }

        // Sort: current session first, then by recency
        merged.sort((a, b) => {
          if (a.isCurrent && !b.isCurrent) return -1;
          if (!a.isCurrent && b.isCurrent) return 1;
          return 0; // already sorted by mtime from discovery
        });

        // One message per session, each with its own resume button
        for (const s of merged.slice(0, 5)) {
          const displayTitle = escapeHtml(s.title);
          const kb = new InlineKeyboard();
          if (s.isCurrent) {
            const repoLine = repo ? `\n📂 <code>${escapeHtml(shortenRepoPath(repo))}</code>` : '';
            const sessModel = agent.model;
            const modelLine = sessModel ? `\n🤖 ${escapeHtml(sessModel)}` : '';
            const sessionLine = `\n📎 <code>${escapeHtml(s.id.slice(0, 8))}</code>`;
            const text = `<blockquote><b>Current session:</b>\n${displayTitle}\n${s.detail} · ${s.age}${repoLine}${modelLine}${sessionLine}</blockquote>`;
            await agent.tgBot.sendText(cmd.chatId, text, 'HTML');
          } else {
            const text = `${displayTitle}\n<code>${escapeHtml(s.id.slice(0, 8))}</code> · ${s.detail} · ${s.age}`;
            const btnTitle = s.title.length > 30 ? s.title.slice(0, 30) + '…' : s.title;
            kb.text(`▶ ${btnTitle}`, `resume:${s.id}`);
            await agent.tgBot.sendTextWithKeyboard(cmd.chatId, text, kb, 'HTML');
          }
        }
        break;
      }

      case 'resume': {
        if (!cmd.args) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /resume &lt;session-id&gt;</blockquote>', 'HTML');
          break;
        }
        this.killAgentProcess(agentId);
        agent.pendingSessionId = cmd.args.trim();
        await agent.tgBot.sendText(cmd.chatId, `Will resume session <code>${escapeHtml(cmd.args.trim().slice(0, 8))}</code> on next message.`, 'HTML');
        break;
      }

      case 'session': {
        const currentSessionId = agent.ccProcess?.sessionId;
        if (!currentSessionId) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active session.</blockquote>', 'HTML');
          break;
        }
        const discovered = agent.repo ? discoverCCSessions(agent.repo, 20) : [];
        const info = discovered.find(d => d.id === currentSessionId);
        if (!info) {
          await agent.tgBot.sendText(cmd.chatId, `<b>Session:</b> <code>${escapeHtml(currentSessionId.slice(0, 8))}</code>`, 'HTML');
          break;
        }
        const ctxLine = info.contextPct !== null ? `\n<b>Context:</b> ${info.contextPct}%` : '';
        const modelLine = info.model ? `\n<b>Model:</b> ${escapeHtml(info.model)}` : '';
        await agent.tgBot.sendText(cmd.chatId,
          `<b>Session:</b> <code>${escapeHtml(info.id.slice(0, 8))}</code>\n<b>Title:</b> ${escapeHtml(info.title)}${modelLine}${ctxLine}\n<b>Age:</b> ${formatAge(info.mtime)}`,
          'HTML'
        );
        break;
      }

      case 'model': {
        const MODEL_OPTIONS = ['opus', 'sonnet', 'haiku'];
        if (!cmd.args) {
          const current = agent.model || 'default';
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
        const newModel = cmd.args.trim();
        agent.model = newModel;
        this.sessionStore.setModel(agentId, newModel);
        this.killAgentProcess(agentId);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>Model set to <code>${escapeHtml(newModel)}</code>. Process respawned.</blockquote>`, 'HTML');
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
          const current = agent.repo;
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
        this.killAgentProcess(agentId);
        agent.repo = repoPath;
        agent.pendingSessionId = null; // clear session when repo changes
        this.sessionStore.setRepo(agentId, repoPath);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>Repo set to <code>${escapeHtml(shortenRepoPath(repoPath))}</code>. Session cleared.</blockquote>`, 'HTML');
        break;
      }

      case 'cancel': {
        if (agent.ccProcess && agent.ccProcess.state === 'active') {
          agent.ccProcess.cancel();
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Cancelled.</blockquote>', 'HTML');
        } else {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active turn to cancel.</blockquote>', 'HTML');
        }
        break;
      }

      case 'compact': {
        if (!agent.ccProcess || agent.ccProcess.state !== 'active') {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active session to compact. Start one first.</blockquote>', 'HTML');
          break;
        }
        const compactMsg = cmd.args?.trim()
          ? `/compact ${cmd.args.trim()}`
          : '/compact';
        await agent.tgBot.sendText(cmd.chatId, formatSystemMessage('status', 'Compacting…'), 'HTML');
        agent.ccProcess.sendMessage(createTextMessage(compactMsg));
        break;
      }

      case 'catchup': {
        // Catchup now just shows recent sessions via /sessions
        await agent.tgBot.sendText(cmd.chatId, '<blockquote>Use /sessions to see recent sessions.</blockquote>', 'HTML');
        break;
      }

      case 'permissions': {
        const validModes = ['dangerously-skip', 'acceptEdits', 'default', 'plan'];
        const agentDefault = agent.config.defaults.permissionMode;
        const agentState = this.sessionStore.getAgent(agentId);
        const currentMode = agentState.permissionMode || agentDefault;

        if (cmd.args) {
          const mode = cmd.args.trim();
          if (!validModes.includes(mode)) {
            await agent.tgBot.sendText(cmd.chatId, `<blockquote>Invalid mode. Valid: ${validModes.join(', ')}</blockquote>`, 'HTML');
            break;
          }
          this.sessionStore.setPermissionMode(agentId, mode);
          this.killAgentProcess(agentId);
          await agent.tgBot.sendText(cmd.chatId, `Permission mode set to <code>${escapeHtml(mode)}</code>. Takes effect on next message.`, 'HTML');
          break;
        }

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
        this.killAgentProcess(agentId);
        agent.pendingSessionId = sessionId;
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
        // Kill process if it's running this session
        if (agent.ccProcess?.sessionId === sessionId) {
          this.killAgentProcess(agentId);
        }
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Session cleared');
        await agent.tgBot.sendText(query.chatId, `Session <code>${escapeHtml(sessionId.slice(0, 8))}</code> cleared.`, 'HTML');
        break;
      }

      case 'repo': {
        const repoName = query.data;
        const repoPath = resolveRepoPath(this.config.repos, repoName);
        if (!existsSync(repoPath)) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Path not found');
          break;
        }
        this.killAgentProcess(agentId);
        agent.repo = repoPath;
        agent.pendingSessionId = null;
        this.sessionStore.setRepo(agentId, repoPath);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Repo: ${repoName}`);
        await agent.tgBot.sendText(query.chatId, `<blockquote>Repo set to <code>${escapeHtml(shortenRepoPath(repoPath))}</code>. Session cleared.</blockquote>`, 'HTML');
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
        agent.model = model;
        this.sessionStore.setModel(agentId, model);
        this.killAgentProcess(agentId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Model: ${model}`);
        await agent.tgBot.sendText(query.chatId, `<blockquote>Model set to <code>${escapeHtml(model)}</code>. Process respawned.</blockquote>`, 'HTML');
        break;
      }

      case 'permissions': {
        const validModes = ['dangerously-skip', 'acceptEdits', 'default', 'plan'];
        const mode = query.data;
        if (!validModes.includes(mode)) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Invalid mode');
          break;
        }
        this.sessionStore.setPermissionMode(agentId, mode);
        this.killAgentProcess(agentId);
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
        if (agent.ccProcess) {
          agent.ccProcess.respondToPermission(requestId, true);
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
        if (agent.ccProcess) {
          agent.ccProcess.respondToPermission(requestId, false);
        }
        agent.pendingPermissions.delete(requestId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '❌ Denied');
        break;
      }

      case 'perm_allow_all': {
        // Allow all pending permissions for this agent
        const toAllow: string[] = [];
        for (const [reqId] of agent.pendingPermissions) {
          toAllow.push(reqId);
        }
        for (const reqId of toAllow) {
          if (agent.ccProcess) agent.ccProcess.respondToPermission(reqId, true);
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
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // If explicit session requested, set it as pending
    if (sessionId) {
      agent.pendingSessionId = sessionId;
    }

    // Route through the same sendToCC path as Telegram
    this.sendToCC(agentId, { text });

    return {
      type: 'ack',
      sessionId: agent.ccProcess?.sessionId ?? null,
      state: agent.ccProcess?.state ?? 'idle',
    };
  }

  handleCtlStatus(agentId?: string): CtlStatusResponse {
    const agents: CtlStatusResponse['agents'] = [];
    const sessions: CtlStatusResponse['sessions'] = [];

    const agentIds = agentId ? [agentId] : [...this.agents.keys()];

    for (const id of agentIds) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      const state = agent.ccProcess?.state ?? 'idle';

      agents.push({
        id,
        state,
        sessionId: agent.ccProcess?.sessionId ?? null,
        repo: agent.repo,
      });

      // List sessions from CC's session directory
      if (agent.repo) {
        for (const d of discoverCCSessions(agent.repo, 5)) {
          sessions.push({
            id: d.id,
            agentId: id,
            messageCount: d.lineCount,
            totalCostUsd: 0,
          });
        }
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

    // Use the agent's primary chat for MCP tool output
    const chatId = this.getAgentChatId(agent);
    if (!chatId) {
      return { id: request.id, success: false, error: `No chat ID for agent: ${request.agentId}` };
    }

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

  // ── Supervisor protocol ──

  private isSupervisorSubscribed(agentId: string, sessionId: string | null): boolean {
    return this.supervisorSubscriptions.has(`${agentId}:*`) ||
      (sessionId !== null && this.supervisorSubscriptions.has(`${agentId}:${sessionId}`));
  }

  registerSupervisor(agentId: string, capabilities: string[], writeFn: (line: string) => void): void {
    this.supervisorAgentId = agentId;
    this.supervisorWrite = writeFn;
    this.supervisorSubscriptions.clear();
    this.logger.info({ agentId, capabilities }, 'Supervisor registered');
  }

  handleSupervisorDetach(): void {
    this.logger.info({ agentId: this.supervisorAgentId }, 'Supervisor detached');
    this.supervisorSubscriptions.clear();
    this.supervisorWrite = null;
    this.supervisorAgentId = null;
  }

  handleSupervisorLine(line: string): void {
    let msg: { type: string; requestId?: string; action?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendToSupervisor({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    if (msg.type !== 'command' || !msg.action) {
      this.sendToSupervisor({ type: 'error', message: 'Expected {type:"command", action:"..."}' });
      return;
    }

    const requestId = msg.requestId;
    const params = msg.params ?? {};

    try {
      const result = this.handleSupervisorCommand(msg.action, params);
      this.sendToSupervisor({ type: 'response', requestId, result });
    } catch (err) {
      this.sendToSupervisor({ type: 'response', requestId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private handleSupervisorCommand(action: string, params: Record<string, unknown>): unknown {
    switch (action) {
      case 'ping':
        return { pong: true, uptime: process.uptime() };

      case 'send_message': {
        const agentId = params.agentId as string;
        const text = params.text as string;
        if (!agentId || !text) throw new Error('Missing agentId or text');

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);

        // Auto-subscribe supervisor
        this.supervisorSubscriptions.add(`${agentId}:*`);

        // Send to agent's single CC process
        this.sendToCC(agentId, { text });

        // For persistent agents: also send TG system message
        const tgChatId = this.getAgentChatId(agent);
        if (tgChatId) {
          agent.tgBot.sendText(tgChatId, `🦞 <b>OpenClaw:</b> ${escapeHtml(text)}`, 'HTML')
            .catch(err => this.logger.error({ err }, 'Failed to send supervisor TG notification'));
        }

        return {
          sessionId: agent.ccProcess?.sessionId ?? null,
          state: agent.ccProcess?.state ?? 'spawning',
          subscribed: true,
        };
      }

      case 'send_to_cc': {
        const agentId = params.agentId as string;
        const text = params.text as string;
        if (!agentId || !text) throw new Error('Missing agentId or text');

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);

        if (!agent.ccProcess || agent.ccProcess.state === 'idle') {
          throw new Error(`No active CC process for agent ${agentId}`);
        }

        agent.ccProcess.sendMessage(createTextMessage(text));
        return { sent: true };
      }

      case 'subscribe': {
        const agentId = params.agentId as string;
        const sessionId = params.sessionId as string | undefined;
        if (!agentId) throw new Error('Missing agentId');

        const key = sessionId ? `${agentId}:${sessionId}` : `${agentId}:*`;
        this.supervisorSubscriptions.add(key);
        return { subscribed: true, key };
      }

      case 'unsubscribe': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');

        // Remove all subscriptions for this agent
        for (const key of [...this.supervisorSubscriptions]) {
          if (key.startsWith(`${agentId}:`)) {
            this.supervisorSubscriptions.delete(key);
          }
        }
        return { unsubscribed: true };
      }

      case 'status': {
        const filterAgentId = params.agentId as string | undefined;
        const agents: unknown[] = [];
        const agentIds = filterAgentId ? [filterAgentId] : [...this.agents.keys()];

        for (const id of agentIds) {
          const agent = this.agents.get(id);
          if (!agent) continue;

          const state = agent.ccProcess?.state ?? 'idle';
          const sessionId = agent.ccProcess?.sessionId ?? null;

          agents.push({
            id,
            type: 'persistent',
            state,
            sessionId,
            repo: agent.repo,
            supervisorSubscribed: this.isSupervisorSubscribed(id, sessionId),
          });
        }

        return { agents };
      }

      case 'kill_cc': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);

        const killed = agent.ccProcess != null && agent.ccProcess.state !== 'idle';
        if (killed) {
          this.killAgentProcess(agentId);
        }

        return { killed };
      }

      default:
        throw new Error(`Unknown supervisor action: ${action}`);
    }
  }

  private sendToSupervisor(msg: Record<string, unknown>): void {
    if (this.supervisorWrite) {
      try { this.supervisorWrite(JSON.stringify(msg) + '\n'); } catch {}
    }
  }

  // ── Shutdown ──

  async stop(): Promise<void> {
    this.logger.info('Stopping bridge');

    for (const agentId of [...this.agents.keys()]) {
      await this.stopAgent(agentId);
    }

    this.processRegistry.clear();
    this.mcpServer.closeAll();
    this.ctlServer.closeAll();
    this.removeAllListeners();
    this.logger.info('Bridge stopped');
  }
}

// ── Helpers ──

function shortModel(m: string): string {
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('haiku')) return 'haiku';
  return m.length > 15 ? m.slice(0, 15) + '…' : m;
}

function shortenRepoPath(p: string): string {
  return p
    .replace(/^\/home\/[^/]+\/Botverse\//, '')
    .replace(/^\/home\/[^/]+\/Projects\//, '')
    .replace(/^\/home\/[^/]+\//, '~/');
}

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

