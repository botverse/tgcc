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
import { StreamAccumulator, SubAgentTracker, splitText, escapeHtml, type TelegramSender, type SubAgentSender, type MailboxMessage } from './streaming.js';
import { TelegramBot, type TelegramMessage, type SlashCommand, type CallbackQuery } from './telegram.js';
import { InlineKeyboard } from 'grammy';
import { McpBridgeServer, type McpToolRequest, type McpToolResponse } from './mcp-bridge.js';
import {
  SessionStore,
  getSessionJsonlPath,
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
  processes: Map<string, CCProcess>;       // userId → CCProcess
  accumulators: Map<string, StreamAccumulator>; // `${userId}:${chatId}` → accumulator
  subAgentTrackers: Map<string, SubAgentTracker>; // `${userId}:${chatId}` → tracker
  batchers: Map<string, MessageBatcher>;   // userId → batcher
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
  private sessionModelOverrides = new Map<string, string>();  // "agentId:userId" → model (from /model cmd, not persisted)
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

    // Unsubscribe all clients for this agent from the registry
    for (const [userId] of agent.processes) {
      const chatId = Number(userId); // In TG, private chat ID === user ID
      const clientRef: ClientRef = { agentId, userId, chatId };
      this.processRegistry.unsubscribe(clientRef);
    }

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

    const clientRef: ClientRef = { agentId, userId, chatId };

    // Check if this client already has a process via the registry
    let existingEntry = this.processRegistry.findByClient(clientRef);
    let proc = existingEntry?.ccProcess;

    if (proc?.takenOver) {
      // Session was taken over externally — discard old process
      const entry = this.processRegistry.findByClient(clientRef)!;
      this.processRegistry.destroy(entry.repo, entry.sessionId);
      agent.processes.delete(userId);
      proc = undefined;
      existingEntry = null;
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
        const entry = this.processRegistry.findByClient(clientRef)!;
        this.processRegistry.unsubscribe(clientRef);
        agent.processes.delete(userId);
        proc = undefined;
        existingEntry = null;
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

      // Check if another client already has a process for this repo+session
      const sessionId = userState2.currentSessionId;
      if (sessionId && resolvedRepo) {
        const sharedEntry = this.processRegistry.get(resolvedRepo, sessionId);
        if (sharedEntry && sharedEntry.ccProcess.state !== 'idle') {
          // Attach to existing process as subscriber
          this.processRegistry.subscribe(resolvedRepo, sessionId, clientRef);
          proc = sharedEntry.ccProcess;
          agent.processes.set(userId, proc);

          // Notify the user they've attached
          agent.tgBot.sendText(
            chatId,
            '<blockquote>📎 Attached to existing session process.</blockquote>',
            'HTML',
          ).catch(err => this.logger.error({ err }, 'Failed to send attach notification'));

          // Show typing indicator and forward message
          this.startTypingIndicator(agent, userId, chatId);
          proc.sendMessage(ccMsg);
          return;
        }
      }

      // Save first message text as pending session title
      if (data.text) {
      }
      proc = this.spawnCCProcess(agentId, userId, chatId);
      agent.processes.set(userId, proc);
    }

    // Show typing indicator (repeated every 4s — TG typing expires after ~5s)
    this.startTypingIndicator(agent, userId, chatId);

    proc.sendMessage(ccMsg);
  }

  /** Check if the session JSONL was modified externally since we last tracked it. */
  private checkSessionStaleness(_agentId: string, _userId: string): { summary: string } | null {
    // With shared process registry, staleness is handled by the registry itself
    return null;
  }

  // ── Process cleanup helper ──

  /**
   * Disconnect a client from its CC process.
   * If other subscribers remain, the process stays alive.
   * If this was the last subscriber, the process is destroyed.
   */
  private disconnectClient(agentId: string, userId: string, chatId: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const clientRef: ClientRef = { agentId, userId, chatId };
    const proc = agent.processes.get(userId);
    const destroyed = this.processRegistry.unsubscribe(clientRef);

    if (!destroyed && proc) {
      // Other subscribers still attached — just remove from this agent's map
    } else if (proc && !destroyed) {
      // Not in registry but has a process — destroy directly (legacy path)
      proc.destroy();
    }

    agent.processes.delete(userId);
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

    // Check session store for repo/permission overrides
    const userState = this.sessionStore.getUser(agentId, userId);
    if (userState.repo) userConfig.repo = userState.repo;

    // Model priority: /model override > running process > session JSONL > agent config default
    const modelOverride = this.sessionModelOverrides.get(`${agentId}:${userId}`);
    if (modelOverride) {
      userConfig.model = modelOverride;
      // Don't delete yet — cleared when CC writes first assistant message
    } else {
      const currentSessionId = userState.currentSessionId;
      if (currentSessionId && userConfig.repo) {
        const registryEntry = this.processRegistry.get(userConfig.repo, currentSessionId);
        if (registryEntry?.model) {
          userConfig.model = registryEntry.model;
        } else {
          const sessions = discoverCCSessions(userConfig.repo, 20);
          const sessionInfo = sessions.find(s => s.id === currentSessionId);
          if (sessionInfo?.model) {
            userConfig.model = sessionInfo.model;
          }
        }
      }
    }
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

    // Register in the process registry
    const ownerRef: ClientRef = { agentId, userId, chatId };
    // We'll register once we know the sessionId (on init), but we need a
    // temporary entry for pre-init event routing. Use a placeholder sessionId
    // that gets updated on init.
    const tentativeSessionId = userState.currentSessionId ?? `pending-${Date.now()}`;
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
      this.sessionStore.setCurrentSession(agentId, userId, event.session_id);

      // Update registry key if session ID changed from tentative
      if (event.session_id !== tentativeSessionId) {
        // Re-register with the real session ID
        const entry = getEntry();
        if (entry) {
          // Save subscribers before removing
          const savedSubs = [...entry.subscribers.entries()];
          this.processRegistry.remove(userConfig.repo, tentativeSessionId);
          const newEntry = this.processRegistry.register(userConfig.repo, event.session_id, userConfig.model || 'default', proc, ownerRef);
          // Restore additional subscribers
          for (const [, sub] of savedSubs) {
            if (sub.client.agentId !== agentId || sub.client.userId !== userId || sub.client.chatId !== chatId) {
              this.processRegistry.subscribe(userConfig.repo, event.session_id, sub.client);
              const newSub = this.processRegistry.getSubscriber(newEntry, sub.client);
              if (newSub) {
                newSub.accumulator = sub.accumulator;
                newSub.tracker = sub.tracker;
              }
            }
          }
        }
      }
    });

    proc.on('stream_event', (event: StreamInnerEvent) => {
      const entry = getEntry();
      if (!entry) {
        // Fallback: single subscriber mode (shouldn't happen)
        this.handleStreamEvent(agentId, userId, chatId, event);
        return;
      }
      for (const sub of this.processRegistry.subscribers(entry)) {
        this.handleStreamEvent(sub.client.agentId, sub.client.userId, sub.client.chatId, event);
      }
    });

    proc.on('tool_result', (event: ToolResultEvent) => {
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];

      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;

        const accKey = `${sub.client.userId}:${sub.client.chatId}`;

        // Resolve tool indicator message with success/failure status
        const acc2 = subAgent.accumulators.get(accKey);
        if (acc2 && event.tool_use_id) {
          const isError = event.is_error === true;
          const contentStr = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
          const errorMsg = isError ? contentStr : undefined;
          acc2.resolveToolMessage(event.tool_use_id, isError, errorMsg, contentStr, event.tool_use_result);
        }

        const tracker = subAgent.subAgentTrackers.get(accKey);
        if (!tracker) continue;

        const resultText = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
        const meta = event.tool_use_result;

        // Log warning if structured metadata is missing
        if (!meta && /agent_id:\s*\S+@\S+/.test(resultText)) {
          this.logger.warn({ agentId: sub.client.agentId, toolUseId: event.tool_use_id }, 'Spawn detected in text but no structured tool_use_result metadata - skipping');
        }

        const spawnMeta = meta?.status === 'teammate_spawned' ? meta : undefined;

        if (spawnMeta?.status === 'teammate_spawned' && spawnMeta.team_name) {
          if (!tracker.currentTeamName) {
            this.logger.info({ agentId: sub.client.agentId, teamName: spawnMeta.team_name, agentName: spawnMeta.name, agentType: spawnMeta.agent_type }, 'Spawn detected');
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
      }
    });

    // System events for background task tracking — broadcast to all subscribers
    proc.on('task_started', (event: TaskStartedEvent) => {
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        const accKey = `${sub.client.userId}:${sub.client.chatId}`;
        const tracker = subAgent.subAgentTrackers.get(accKey);
        if (tracker) {
          tracker.handleTaskStarted(event.tool_use_id, event.description, event.task_type);
        }
      }
    });

    proc.on('task_progress', (event: TaskProgressEvent) => {
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        const accKey = `${sub.client.userId}:${sub.client.chatId}`;
        const tracker = subAgent.subAgentTrackers.get(accKey);
        if (tracker) {
          tracker.handleTaskProgress(event.tool_use_id, event.description, event.last_tool_name);
        }
      }
    });

    proc.on('task_completed', (event: TaskCompletedEvent) => {
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        const accKey = `${sub.client.userId}:${sub.client.chatId}`;
        const tracker = subAgent.subAgentTrackers.get(accKey);
        if (tracker) {
          tracker.handleTaskCompleted(event.tool_use_id);
        }
      }
    });

    // Media from tool results (images, PDFs, etc.) — broadcast to all subscribers
    proc.on('media', (media: { kind: string; media_type: string; data: string }) => {
      const buf = Buffer.from(media.data, 'base64');
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        if (media.kind === 'image') {
          subAgent.tgBot.sendPhotoBuffer(sub.client.chatId, buf).catch(err => {
            this.logger.error({ err, agentId: sub.client.agentId, userId: sub.client.userId }, 'Failed to send tool_result image');
          });
        } else if (media.kind === 'document') {
          const ext = media.media_type === 'application/pdf' ? '.pdf' : '';
          subAgent.tgBot.sendDocumentBuffer(sub.client.chatId, buf, `document${ext}`).catch(err => {
            this.logger.error({ err, agentId: sub.client.agentId, userId: sub.client.userId }, 'Failed to send tool_result document');
          });
        }
      }
    });

    proc.on('assistant', (event: AssistantMessage) => {
      // Non-streaming fallback — only used if stream_events don't fire
      // In practice, stream_events handle the display
    });

    proc.on('result', (event: ResultEvent) => {
      // Model override consumed — CC has written to JSONL
      this.sessionModelOverrides.delete(`${agentId}:${userId}`);

      // Broadcast result to all subscribers
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        this.stopTypingIndicator(subAgent, sub.client.userId, sub.client.chatId);
        this.handleResult(sub.client.agentId, sub.client.userId, sub.client.chatId, event);
      }
    });

    proc.on('compact', (event: CompactBoundaryEvent) => {
      // Notify all subscribers that compaction happened
      const trigger = event.compact_metadata?.trigger ?? 'manual';
      const preTokens = event.compact_metadata?.pre_tokens;
      const tokenInfo = preTokens ? ` (was ${Math.round(preTokens / 1000)}k tokens)` : '';
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        const label = trigger === 'auto' ? '🗜️ Auto-compacted' : '🗜️ Compacted';
        subAgent.tgBot.sendText(
          sub.client.chatId,
          `<blockquote>${escapeHtml(label + tokenInfo)}</blockquote>`,
          'HTML'
        ).catch((err: Error) => this.logger.error({ err }, 'Failed to send compact notification'));
      }
    });

    proc.on('permission_request', (event: PermissionRequest) => {
      // Send permission request only to the owner (first subscriber)
      const req = event.request;
      const requestId = event.request_id;

      // Store pending permission on the owner's agent
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

      // Broadcast API error to all subscribers
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        subAgent.tgBot.sendText(sub.client.chatId, text, 'HTML')
          .catch(err => this.logger.error({ err }, 'Failed to send API error notification'));
      }
    });

    proc.on('hang', () => {
      // Broadcast hang notification to all subscribers
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        this.stopTypingIndicator(subAgent, sub.client.userId, sub.client.chatId);
        subAgent.tgBot.sendText(sub.client.chatId, '<blockquote>⏸ Session paused. Send a message to continue.</blockquote>', 'HTML')
          .catch(err => this.logger.error({ err }, 'Failed to send hang notification'));
      }
    });

    proc.on('takeover', () => {
      this.logger.warn({ agentId, userId }, 'Session takeover detected — keeping session for roaming');
      // Notify and clean up all subscribers
      const entry = getEntry();
      if (entry) {
        for (const sub of this.processRegistry.subscribers(entry)) {
          const subAgent = this.agents.get(sub.client.agentId);
          if (!subAgent) continue;
          this.stopTypingIndicator(subAgent, sub.client.userId, sub.client.chatId);
          subAgent.processes.delete(sub.client.userId);
        }
        // Remove from registry without destroying (already handling exit)
        this.processRegistry.remove(entry.repo, entry.sessionId);
      }
      // Don't clear session — allow roaming between clients.
      proc.destroy();
    });

    proc.on('exit', () => {
      // Clean up all subscribers
      const entry = getEntry();
      if (entry) {
        for (const sub of this.processRegistry.subscribers(entry)) {
          const subAgent = this.agents.get(sub.client.agentId);
          if (!subAgent) continue;
          this.stopTypingIndicator(subAgent, sub.client.userId, sub.client.chatId);

          const accKey = `${sub.client.userId}:${sub.client.chatId}`;
          const acc = subAgent.accumulators.get(accKey);
          if (acc) {
            acc.finalize();
            subAgent.accumulators.delete(accKey);
          }
          const exitTracker = subAgent.subAgentTrackers.get(accKey);
          if (exitTracker) {
            exitTracker.stopMailboxWatch();
          }
          subAgent.subAgentTrackers.delete(accKey);
        }
        // Remove from registry (process already exited)
        this.processRegistry.remove(entry.repo, entry.sessionId);
      } else {
        // Fallback: clean up owner only
        this.stopTypingIndicator(agent, userId, chatId);
        const accKey = `${userId}:${chatId}`;
        const acc = agent.accumulators.get(accKey);
        if (acc) {
          acc.finalize();
          agent.accumulators.delete(accKey);
        }
        const exitTracker = agent.subAgentTrackers.get(accKey);
        if (exitTracker) {
          exitTracker.stopMailboxWatch();
        }
        agent.subAgentTrackers.delete(accKey);
      }
    });

    proc.on('error', (err: Error) => {
      // Broadcast error to all subscribers
      const entry = getEntry();
      const subscriberList = entry ? [...this.processRegistry.subscribers(entry)] : [{ client: ownerRef }];
      for (const sub of subscriberList) {
        const subAgent = this.agents.get(sub.client.agentId);
        if (!subAgent) continue;
        this.stopTypingIndicator(subAgent, sub.client.userId, sub.client.chatId);
        subAgent.tgBot.sendText(sub.client.chatId, `<blockquote>⚠️ ${escapeHtml(String(err.message))}</blockquote>`, 'HTML')
          .catch(err2 => this.logger.error({ err: err2 }, 'Failed to send process error notification'));
      }
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
          model: (event as { model?: string }).model
            ?? this.processRegistry.findByClient({ agentId, userId, chatId })?.model,
        });
      }
      acc.finalize();
      // Don't delete — next turn will reset via message_start and create a new message
    }

    // Update session store with cost
    if (event.total_cost_usd) {
    }

    // Update JSONL tracking after our own CC turn completes
    // This prevents false-positive staleness on our own writes

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
        const userConf = resolveUserConfig(agent.config, cmd.userId);
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const repo = userState.repo || userConf.repo;
        const session = userState.currentSessionId;
        // Model: running process > session JSONL > user default
        let model = userConf.model;
        if (session && repo) {
          const registryEntry = this.processRegistry.get(repo, session);
          if (registryEntry?.model) {
            model = registryEntry.model;
          } else {
            const sessions = discoverCCSessions(repo, 20);
            const sessionInfo = sessions.find(s => s.id === session);
            if (sessionInfo?.model) model = sessionInfo.model;
          }
        }
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
          `<b>Model:</b> ${escapeHtml(resolveUserConfig(agent.config, cmd.userId).model)}`,
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
        this.disconnectClient(agentId, cmd.userId, cmd.chatId);
        this.sessionStore.clearSession(agentId, cmd.userId);
        const newConf = resolveUserConfig(agent.config, cmd.userId);
        const newState = this.sessionStore.getUser(agentId, cmd.userId);
        const newRepo = newState.repo || newConf.repo;
        const newModel = newState.model || newConf.model;
        const newLines = ['Session cleared. Next message starts fresh.'];
        if (newRepo) newLines.push(`📂 <code>${escapeHtml(shortenRepoPath(newRepo))}</code>`);
        if (newModel) newLines.push(`🤖 ${escapeHtml(newModel)}`);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>${newLines.join('\n')}</blockquote>`, 'HTML');
        break;
      }

      case 'continue': {
        this.disconnectClient(agentId, cmd.userId, cmd.chatId);
        const contConf = resolveUserConfig(agent.config, cmd.userId);
        const contState = this.sessionStore.getUser(agentId, cmd.userId);
        const contRepo = contState.repo || contConf.repo;
        let contSession = contState.currentSessionId;

        // If no current session, auto-pick the most recent one
        if (!contSession && contRepo) {
          const recent = discoverCCSessions(contRepo, 1);
          if (recent.length > 0) {
            contSession = recent[0].id;
            this.sessionStore.setCurrentSession(agentId, cmd.userId, contSession);
          }
        }

        // Model priority: running process registry > session JSONL > user default
        let contModel = contConf.model;
        if (contSession && contRepo) {
          // Check if a process is already running for this session
          const registryEntry = this.processRegistry.get(contRepo, contSession);
          if (registryEntry?.model) {
            contModel = registryEntry.model;
          } else {
            const sessions = discoverCCSessions(contRepo, 20);
            const sessionInfo = sessions.find(s => s.id === contSession);
            if (sessionInfo?.model) contModel = sessionInfo.model;
          }
        }
        const contLines = ['Process respawned. Session kept.'];
        if (contRepo) contLines.push(`📂 <code>${escapeHtml(shortenRepoPath(contRepo))}</code>`);
        if (contModel) contLines.push(`🤖 ${escapeHtml(contModel)}`);
        if (contSession) contLines.push(`📎 <code>${escapeHtml(contSession.slice(0, 8))}</code>`);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>${contLines.join('\n')}</blockquote>`, 'HTML');
        break;
      }

      case 'sessions': {
        const userConf = resolveUserConfig(agent.config, cmd.userId);
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        const repo = userState.repo || userConf.repo;
        const currentSessionId = userState.currentSessionId;

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
            const sessModel = userConf.model;
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
        this.disconnectClient(agentId, cmd.userId, cmd.chatId);
        this.sessionStore.setCurrentSession(agentId, cmd.userId, cmd.args.trim());
        await agent.tgBot.sendText(cmd.chatId, `Will resume session <code>${escapeHtml(cmd.args.trim().slice(0, 8))}</code> on next message.`, 'HTML');
        break;
      }

      case 'session': {
        const userState = this.sessionStore.getUser(agentId, cmd.userId);
        if (!userState.currentSessionId) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active session.</blockquote>', 'HTML');
          break;
        }
        const sessRepo = userState.repo || resolveUserConfig(agent.config, cmd.userId).repo;
        const discovered = sessRepo ? discoverCCSessions(sessRepo, 20) : [];
        const info = discovered.find(d => d.id === userState.currentSessionId);
        if (!info) {
          await agent.tgBot.sendText(cmd.chatId, `<b>Session:</b> <code>${escapeHtml(userState.currentSessionId.slice(0, 8))}</code>`, 'HTML');
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
          // Show model from: running process > JSONL > agent config
          const uState = this.sessionStore.getUser(agentId, cmd.userId);
          const uConf = resolveUserConfig(agent.config, cmd.userId);
          const uRepo = uState.repo || uConf.repo;
          const uSession = uState.currentSessionId;
          let current = uConf.model || 'default';
          if (uSession && uRepo) {
            const re = this.processRegistry.get(uRepo, uSession);
            if (re?.model) current = re.model;
            else {
              const ds = discoverCCSessions(uRepo, 20);
              const si = ds.find(s => s.id === uSession);
              if (si?.model) current = si.model;
            }
          }
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
        // Store as session-level override (not user default)
        const curSession = this.sessionStore.getUser(agentId, cmd.userId).currentSessionId;
        this.sessionModelOverrides.set(`${agentId}:${cmd.userId}`, newModel);
        this.disconnectClient(agentId, cmd.userId, cmd.chatId);
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
        this.disconnectClient(agentId, cmd.userId, cmd.chatId);
        this.sessionStore.setRepo(agentId, cmd.userId, repoPath);
        // Always clear session when repo changes — sessions are project-specific
        this.sessionStore.clearSession(agentId, cmd.userId);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>Repo set to <code>${escapeHtml(shortenRepoPath(repoPath))}</code>. Session cleared.</blockquote>`, 'HTML');
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

      case 'compact': {
        // Trigger CC's built-in /compact slash command — like the Claude Code extension does
        const proc = agent.processes.get(cmd.userId);
        if (!proc || proc.state !== 'active') {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active session to compact. Start one first.</blockquote>', 'HTML');
          break;
        }
        // Build the compact message: "/compact [optional-instructions]"
        const compactMsg = cmd.args?.trim()
          ? `/compact ${cmd.args.trim()}`
          : '/compact';
        await agent.tgBot.sendText(cmd.chatId, '<blockquote>🗜️ Compacting…</blockquote>', 'HTML');
        proc.sendMessage(createTextMessage(compactMsg));
        break;
      }

      case 'catchup': {
        // Catchup now just shows recent sessions via /sessions
        await agent.tgBot.sendText(cmd.chatId, '<blockquote>Use /sessions to see recent sessions.</blockquote>', 'HTML');
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
          this.disconnectClient(agentId, cmd.userId, cmd.chatId);
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
        this.disconnectClient(agentId, query.userId, query.chatId);
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
        // Clear current session if it matches
        const uState = this.sessionStore.getUser(agentId, query.userId);
        if (uState.currentSessionId === sessionId) {
          this.sessionStore.setCurrentSession(agentId, query.userId, '');
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
        // Kill current process (different CWD needs new process)
        this.disconnectClient(agentId, query.userId, query.chatId);
        this.sessionStore.setRepo(agentId, query.userId, repoPath);
        // Always clear session when repo changes — sessions are project-specific
        this.sessionStore.clearSession(agentId, query.userId);
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
        this.sessionModelOverrides.set(`${agentId}:${query.userId}`, model);
        this.disconnectClient(agentId, query.userId, query.chatId);
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
        this.sessionStore.setPermissionMode(agentId, query.userId, mode);
        // Kill current process so new mode takes effect on next spawn
        this.disconnectClient(agentId, query.userId, query.chatId);
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

      // List sessions for this agent from CC's session directory
      const userState = this.sessionStore.getUser(id, userId);
      const sessRepo = userState.repo || userConfig.repo;
      if (sessRepo) {
        for (const d of discoverCCSessions(sessRepo, 5)) {
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

