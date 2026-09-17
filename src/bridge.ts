import { join, dirname } from 'node:path';
import { existsSync, readFileSync, statSync, mkdirSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';
import pino from 'pino';
import type {
  TgccConfig,
  AgentConfig,
  ConfigDiff,
  CronJobConfig,
} from './config.js';
import type { ApiErrorEvent, PermissionRequest, ToolResultEvent, TaskStartedEvent, TaskProgressEvent, TaskCompletedEvent, CompactBoundaryEvent } from './cc-protocol.js';
import { resolveUserConfig, resolveRepoPath, updateConfig, isValidRepoName, findRepoOwner, expandPath } from './config.js';
import { CCProcess, generateMcpConfig, type ICCProcess } from './cc-process.js';
import { ContainerCCProcess } from './container-process.js';
import { ensureContainer, generateContainerClaudeMd, generateContainerMcpConfig } from './docker.js';
import {
  createTextMessage,
  createImageMessage,
  createMultiImageMessage,
  createDocumentMessage,
  extractAssistantText,
  type InitEvent,
  type AssistantMessage,
  type ResultEvent,
  type StreamInnerEvent,
} from './cc-protocol.js';
import { StreamAccumulator, SubAgentTracker, escapeHtml, formatSystemMessage, type TelegramSender, type SubAgentSender } from './streaming.js';
import { TelegramBot, type TelegramMessage, type SlashCommand, type CallbackQuery } from './telegram.js';
import { isAuthError, resultHasAuthError, runAuthFlow } from './auth.js';
import { InlineKeyboard } from 'grammy';
import { McpBridgeServer, type McpToolRequest, type McpToolResponse } from './mcp-bridge.js';
import {
  SessionStore,
  discoverCCSessions,
  DiscoveredSession,
  getSessionJsonlPath,
  getSessionEndState,
  hasIDEContent,
  computeProjectSlug,
  extractRecentConversation,
  readSessionTitle,
  isRemoteControlSession,
} from './session.js';
import { isSessionExternallyActive } from './session-lock.js';
import {
  CtlServer,
  type CtlHandler,
  type CtlAckResponse,
  type CtlStatusResponse,
  type CtlCliAttachedResponse,
} from './ctl-server.js';
import { ProcessRegistry, type ClientRef, type ProcessEntry } from './process-registry.js';
import { EventBuffer } from './event-buffer.js';
import { HighSignalDetector } from './high-signal.js';
import { EventDedup } from './event-dedup.js';
import { EventRouter, type RoutableEvent } from './event-router.js';
import { SupervisorManager, formatElapsed } from './supervisor.js';
import { WatcherManager } from './watcher.js';
import { RalphManager, buildRalphPrompt } from './ralph.js';
import { ExternalCcManager, sanitizeSessionName, formatAgo } from './external-cc.js';
import { wrapTeammateMessage, wrapSystemReminder } from './cc-tags.js';
import { Scheduler, computeOneShotSchedule, parseEveryToCron } from './scheduler.js';
import { ConversationMonitor, type TurnOrigin } from './monitor.js';
import { randomUUID } from 'node:crypto';
import { exec as nodeExec, execSync } from 'node:child_process';
import { transcribeAudioGemini, buildTranscriptionTurn, type TranscribeResult } from './transcribe.js';

// ── Types ──

interface AskOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options?: Array<AskOption | string>;
  multiSelect?: boolean;
}

interface PendingPermission {
  requestId: string;
  userId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Set when this came from a regular tool_use (not can_use_tool). */
  toolUseId?: string;
  // AskUserQuestion state
  questionMsgId?: number;
  questionChatId?: number;
  questionAnswers?: Record<string, string[]>;  // qIdx → currently selected options
  awaitingTextQIdx?: number;                   // set when waiting for free-text "Other" answer
}

interface PendingExecApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  command: string;
  msgId?: number;
  chatId?: number;
}

/**
 * Per-chat session state. Each Telegram chat talking to an agent gets its own
 * CC process, accumulator and session tracking, so multiple people DMing the
 * same bot never collapse onto a shared conversation.
 */
interface ChatSession {
  chatId: number;
  ccProcess: ICCProcess | null;
  accumulator: StreamAccumulator | null;
  subAgentTracker: SubAgentTracker | null;
  batcher: MessageBatcher | null;
  typingInterval: ReturnType<typeof setInterval> | null;
  pendingSessionId: string | null;         // for /resume: sessionId to use on next spawn
  forceNewSession: boolean;                // /new was used — don't auto-continue on next spawn
  pendingIdeAwareness: boolean;            // resuming a session that was active in an IDE
  cliSessionId: string | null;             // active CC sessionId inside an attached CLI session
}

function createChatSession(chatId: number): ChatSession {
  return {
    chatId,
    ccProcess: null,
    accumulator: null,
    subAgentTracker: null,
    batcher: null,
    typingInterval: null,
    pendingSessionId: null,
    forceNewSession: false,
    pendingIdeAwareness: false,
    cliSessionId: null,
  };
}

interface AgentInstance {
  id: string;
  config: AgentConfig;
  tgBot: TelegramBot | null;              // null for ephemeral agents
  ephemeral: boolean;
  repo: string;                            // resolved repo path (from config or /repo command)
  model: string;                           // resolved model (from config or /model command)
  chatSessions: Map<number, ChatSession>;  // chatId → per-chat CC process + session state
  pendingPermissions: Map<string, PendingPermission>; // requestId → pending permission
  pendingExecApprovals: Map<string, PendingExecApproval>; // id → pending supervisor_exec approval
  lastTgChatId: number | null;             // most recent TG chat that sent a message (for batcher closure)
  lastTgUserId: number | null;             // most recent TG user that sent a message (for group exec permissions)
  destroyTimer: ReturnType<typeof setTimeout> | null; // auto-destroy for ephemeral
  eventBuffer: EventBuffer;               // ring buffer for observability
  awaitingAskCleanup: boolean;            // true when AskUserQuestion was detected this turn → delete fallback bubble on result
  muteOutput: boolean; // suppress TG rendering for wake-triggered supervisor turns
  authFlowInProgress: boolean; // prevents re-entrant auth fallback
  lastSendData: { text: string; source?: { chatId?: number; spawnSource?: 'telegram' | 'supervisor' | 'cli'; alreadyMirrored?: boolean } } | null; // for retry after auth
  claudeConfigDir: string | undefined; // isolated CLAUDE_CONFIG_DIR for docker agents
  pendingCliTmuxAgent: string | null; // waiting for tmux session name reply from /new-cli
}

/** Look up a chat's session state, or undefined if that chat has never messaged. */
function getChatSession(agent: AgentInstance, chatId: number): ChatSession | undefined {
  return agent.chatSessions.get(chatId);
}

/** Look up a chat's session state, creating an empty one if absent. */
function getOrCreateChatSession(agent: AgentInstance, chatId: number): ChatSession {
  let cs = agent.chatSessions.get(chatId);
  if (!cs) {
    cs = createChatSession(chatId);
    agent.chatSessions.set(chatId, cs);
  }
  return cs;
}

export interface InboundTextInput {
  text: string;
  replyToText?: string;
  chatId: number;
  userName?: string;
  userHandle?: string;
}

/**
 * Prepend reply context and, for group chats, sender attribution + roster/groupContext as a
 * system-reminder. Pure and Bridge-independent (no `agent`/`ChatSession` access) so the
 * routing behaviour item 4 depends on — voice/audio/video_note transcripts now getting the
 * same reply-context and group attribution as text — is unit-testable without constructing a
 * full Bridge instance.
 */
export function buildInboundText(input: InboundTextInput, roster: string | null, groupContext: string | undefined): string {
  let text = input.text;
  if (input.replyToText) {
    text = `[Replying to: '${input.replyToText}']\n\n${text}`;
  }
  // In group chats (negative chatId), prepend sender identity so CC knows who's talking
  if (input.chatId < 0 && input.userName) {
    const tag = input.userHandle ? `${input.userName} (@${input.userHandle})` : input.userName;
    text = `[${tag}]: ${text}`;
    // Inject group roster + optional groupContext as system-reminder
    const contextParts = [roster, groupContext].filter(Boolean);
    if (contextParts.length > 0) {
      text = `${wrapSystemReminder(contextParts.join('\n\n'))}\n${text}`;
    }
  }
  return text;
}

// ── /monitor_here authorization ──
//
// Pulled out as a pure function (same pattern as buildInboundText / MessageBatcher above) so
// the authorization decision is unit-testable without constructing a full Bridge instance —
// this is the check that stops the people the monitor exists to watch (e.g. colleagues in
// sentinella's allowedUsers, who can reach sentinella's bot but not the supervisor's) from
// moving or disabling the monitor destination themselves.

export type MonitorHereAuthResult =
  | { ok: true }
  | { ok: false; reason: 'not-supervisor-bot' | 'owner-not-configured' | 'not-owner' };

export function checkMonitorHereAuth(
  agentId: string,
  nativeSupervisorId: string | null,
  callerUserId: string,
  ownerUserId: string | undefined,
): MonitorHereAuthResult {
  if (agentId !== nativeSupervisorId) return { ok: false, reason: 'not-supervisor-bot' };
  if (!ownerUserId) return { ok: false, reason: 'owner-not-configured' };
  if (callerUserId !== ownerUserId) return { ok: false, reason: 'not-owner' };
  return { ok: true };
}

interface SupervisorPendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── Message Batcher ──
//
// Exported (with a pure constructor: injected windowMs + flush callback, no Bridge/Agent
// dependency) so it's unit-testable in isolation — in particular the immediate-flush-on-
// attachment vs 2s-text-window distinction that item 4's routing fix depends on (transcribed
// voice/audio/video_note deliberately omit filePath/fileName so they use the text window and
// can coalesce with a fast follow-up message).

export interface BatcherMessage {
  text: string;
  imageBase64?: string;
  imageMediaType?: string;
  filePath?: string;
  fileName?: string;
  mediaGroupId?: string;
}

export interface BatcherOutput {
  text: string;
  imageBase64?: string;
  imageMediaType?: string;
  images?: Array<{ base64: string; mediaType: string }>;
  filePath?: string;
  fileName?: string;
}

export class MessageBatcher {
  private pending: BatcherMessage[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private mediaGroupTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly windowMs: number;
  private readonly mediaGroupWindowMs = 500; // wait for more photos in the same album
  private flush: (combined: BatcherOutput) => void;

  constructor(windowMs: number, flushFn: (combined: BatcherOutput) => void) {
    this.windowMs = windowMs;
    this.flush = flushFn;
  }

  add(msg: BatcherMessage): void {
    this.pending.push(msg);

    // Media group photo: wait briefly for more photos in the same album
    if (msg.imageBase64 && msg.mediaGroupId) {
      if (this.mediaGroupTimer) clearTimeout(this.mediaGroupTimer);
      this.mediaGroupTimer = setTimeout(() => {
        this.mediaGroupTimer = null;
        this.doFlush();
      }, this.mediaGroupWindowMs);
      return;
    }

    // Single (non-grouped) media: flush immediately
    if (msg.imageBase64 || msg.filePath) {
      this.doFlush();
      return;
    }

    if (!this.timer) {
      this.timer = setTimeout(() => this.doFlush(), this.windowMs);
    }
  }

  private doFlush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.mediaGroupTimer) { clearTimeout(this.mediaGroupTimer); this.mediaGroupTimer = null; }

    if (this.pending.length === 0) return;

    // Collect all images from the batch
    const imageMessages = this.pending.filter(m => m.imageBase64);
    const textParts = this.pending.map(m => m.text).filter(Boolean);
    const combinedText = textParts.join('\n\n');

    if (imageMessages.length > 1) {
      // Multiple images → send as multi-image message
      const images = imageMessages.map(m => ({
        base64: m.imageBase64!,
        mediaType: m.imageMediaType || 'image/jpeg',
      }));
      this.flush({ text: combinedText, images });
    } else if (imageMessages.length === 1) {
      // Single image
      this.flush({
        text: combinedText,
        imageBase64: imageMessages[0].imageBase64,
        imageMediaType: imageMessages[0].imageMediaType,
      });
    } else if (this.pending.length === 1 && (this.pending[0].filePath)) {
      // Single file attachment
      this.flush(this.pending[0]);
    } else {
      // Text-only
      this.flush({ text: combinedText });
    }

    this.pending = [];
  }

  cancel(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.mediaGroupTimer) { clearTimeout(this.mediaGroupTimer); this.mediaGroupTimer = null; }
    this.pending = [];
  }

  destroy(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.mediaGroupTimer) { clearTimeout(this.mediaGroupTimer); this.mediaGroupTimer = null; }
  }
}

// ── Help text ──

const HELP_TEXT = `<b>TGCC Commands</b>

<b>Session</b>
/new — Start a fresh session
/new_cli — Open interactive CLI session via tmux
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
/restart — Restart the TGCC service
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

<b>Cron</b>
/cron list — Show all scheduled jobs
/cron add — Add a new cron job
/cron run &lt;id&gt; — Trigger a job now
/cron remove &lt;id&gt; — Remove a dynamic job

/ralph &lt;prompt&gt; — Spawn shepherd to ensure task completion

/help — This message`;

// ── Bridge ──

export class Bridge extends EventEmitter implements CtlHandler {
  private config: TgccConfig;
  private readonly startedAt = Date.now();
  private agents = new Map<string, AgentInstance>();
  private processRegistry = new ProcessRegistry();
  private mcpServer: McpBridgeServer;
  private ctlServer: CtlServer;
  private sessionStore: SessionStore;
  private logger: pino.Logger;

  // High-signal event detection
  private highSignalDetector: HighSignalDetector;
  private eventDedup: EventDedup;
  private eventRouter: EventRouter;
  private supervisorManager: SupervisorManager | null = null;
  private watcherManager: WatcherManager;
  private ralphManager: RalphManager;
  private externalCc: ExternalCcManager;
  // `${agentId}:${chatId}` → /newcc flow state (name from the command; worktree/repo from keyboard prompts)
  private pendingExtCcNew = new Map<string, { name: string; worktree?: boolean }>();

  // Heartbeat & cron scheduling
  private scheduler: Scheduler;

  // Whisper transcription
  private whisperBin: string | null | undefined; // undefined = not yet resolved

  // Native supervisor (TGCC-internal)
  private nativeSupervisorId: string | null;
  private pendingWaitForResult = new Map<string, {
    resolve: (response: McpToolResponse) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  /** Periodic heartbeat timer that wakes the supervisor with tracked worker status. */

  // External supervisor protocol (OpenClaw plugin)
  private supervisorWrite: ((line: string) => void) | null = null;
  private supervisorAgentId: string | null = null;
  private supervisorSubscriptions = new Set<string>(); // "agentId:sessionId" or "agentId:*"
  private suppressExitForProcess = new Set<string>(); // sessionIds where takeover suppresses exit event
  private supervisorPendingRequests = new Map<string, SupervisorPendingRequest>();
  /** Cache of session-id → derived title (read from JSONL on first turn-complete per session). */
  private sessionTitleCache = new Map<string, string | null>();

  // Conversation monitor: mirrors monitored-agent traffic into a Telegram destination
  // (see work/agent-conversation-monitor/PLAN.md). Off when config.monitor is absent.
  private monitor: ConversationMonitor;

  constructor(config: TgccConfig, logger?: pino.Logger) {
    super();
    this.config = config;
    this.nativeSupervisorId = config.supervisor;
    this.logger = logger ?? pino({ level: config.global.logLevel });
    this.sessionStore = new SessionStore(config.global.stateFile, this.logger);
    this.mcpServer = new McpBridgeServer(
      (req) => this.handleMcpToolRequest(req),
      this.logger,
    );
    this.ctlServer = new CtlServer(this, this.logger, config.supervisor);
    this.scheduler = new Scheduler(this.logger);

    // Route deduped events to supervisor queue and TG chat (used as flush target by EventDedup for batched events like git_commit)
    const routeDedupedEvent = (event: import('./high-signal.js').HighSignalEvent): void => {
      if (event.emoji && event.summary) {
        // Telemetry (commits, milestones, subagent lifecycle, budget) — queue, don't wake CC.
        // Real escalations should arrive via notify_supervisor with priority='high'.
        this.pushSupervisorEvent(event.agentId, `${event.emoji} ${event.summary}`, true, false, 'routine');
      }
    };
    this.eventDedup = new EventDedup(routeDedupedEvent);
    this.eventRouter = new EventRouter();

    this.highSignalDetector = new HighSignalDetector({
      emitSupervisorEvent: (event) => {
        // External supervisor (OpenClaw plugin) — always forward unfiltered
        if (this.isSupervisorSubscribed(event.agentId, this.agentPrimarySessionId(event.agentId))) {
          this.sendToSupervisor(event);
        }
        // Native supervisor queue — tier 1+2 events, filtered through dedup layer
        const ROUTED_EVENTS = new Set(['failure_loop', 'stuck', 'task_milestone', 'build_result', 'git_commit', 'subagent_spawn', 'subagent_all_done', 'budget_alert']);
        if (ROUTED_EVENTS.has(event.event) && event.emoji && event.summary) {
          if (this.eventDedup.shouldForward(event)) {
            // Failure_loop and stuck are genuine escalations — wake CC. The rest are FYI.
            const wakeEvents = new Set(['failure_loop', 'stuck']);
            const priority: 'routine' | 'high' = wakeEvents.has(event.event) ? 'high' : 'routine';
            this.pushSupervisorEvent(event.agentId, `${event.emoji} ${event.summary}`, true, false, priority);
          }
        }
        // Route through EventRouter → delivers to WatcherManager subscribers (ralph) + future consumers
        this.eventRouter.routeHighSignal(event);
      },
      pushEventBuffer: (agentId, line) => {
        const agent = this.agents.get(agentId);
        if (agent) agent.eventBuffer.push(line);
      },
    });

    // Initialize SupervisorManager if a native supervisor is configured
    if (this.nativeSupervisorId) {
      this.supervisorManager = new SupervisorManager(this.nativeSupervisorId, {
        sendToCC: (supId, text) => this.sendToCC(supId, { text }, { spawnSource: 'supervisor' }),
        setMuteOutput: (supId, mute) => {
          const a = this.agents.get(supId);
          if (a) a.muteOutput = mute;
        },
        getSupervisorState: () => {
          const a = this.agents.get(this.nativeSupervisorId!);
          return a ? this.getPrimaryChatSession(a)?.ccProcess?.state : undefined;
        },
        sendTgBlockquote: async (line) => {
          const supAgent = this.agents.get(this.nativeSupervisorId!);
          if (!supAgent?.tgBot) return;
          const chatId = this.getAgentChatId(supAgent);
          if (!chatId) return;
          const acc = this.getPrimaryChatSession(supAgent)?.accumulator;
          if (acc?.hasActiveBubble) { await acc.flushIfDirty(); acc.reset(); }
          await supAgent.tgBot.sendText(chatId, `<blockquote>${escapeHtml(line)}</blockquote>`, 'HTML', true);
        },
        getWorkerStatus: (agentId) => {
          const a = this.agents.get(agentId);
          const agentState = this.sessionStore.getAgent(agentId);
          return {
            state: (a ? this.getPrimaryChatSession(a)?.ccProcess?.state : undefined) ?? 'idle',
            cost: this.highSignalDetector.getSessionCost(agentId),
            contextPct: this.highSignalDetector.getContextPercent(agentId),
            lastActivity: agentState.lastActivity ?? null,
          };
        },
      }, this.logger);
    }

    // Initialize WatcherManager (generic agent-watches-agent via EventRouter)
    this.watcherManager = new WatcherManager(this.eventRouter, {
      sendToCC: (watcherId, text) => this.sendToCC(watcherId, { text }, { spawnSource: 'supervisor' }),
      agentExists: (agentId) => this.agents.has(agentId),
      sendTgBlockquote: async (agentId, text) => {
        const agent = this.agents.get(agentId);
        if (!agent?.tgBot) return;
        const chatId = this.getAgentChatId(agent);
        if (!chatId) return;
        const acc = this.getPrimaryChatSession(agent)?.accumulator;
        if (acc?.hasActiveBubble) { await acc.flushIfDirty(); acc.reset(); }
        await agent.tgBot.sendText(chatId, `<blockquote>${escapeHtml(text)}</blockquote>`, 'HTML', true);
      },
    }, this.logger);

    // Initialize RalphManager (ralph lifecycle: prompt, metadata, TG notifications)
    this.ralphManager = new RalphManager({
      watcherManager: this.watcherManager,
      eventRouter: this.eventRouter,
      supervisorTrack: (agentId) => this.supervisorManager?.track(agentId),
      pushSupervisorEvent: (agentId, text) => this.pushSupervisorEvent(agentId, text),
      sendTgText: async (agentId, chatId, text, parseMode) => {
        const a = this.agents.get(agentId);
        if (!a?.tgBot) throw new Error('Agent has no TG bot');
        await a.tgBot.sendText(chatId, text, parseMode as 'HTML');
      },
    }, this.logger, join(homedir(), '.tgcc', 'ralphs.json'));

    // External CC sessions (tmux windows running `claude --remote-control`)
    this.externalCc = new ExternalCcManager(join(homedir(), '.tgcc', 'external-cc.json'), this.logger);

    // Conversation monitor — reads this.config fresh on every send, so hot-reloading the
    // top-level "monitor" block (including turning it on/off) takes effect immediately.
    this.monitor = new ConversationMonitor({
      getConfig: () => this.config.monitor,
      getSenderBot: () => {
        if (!this.nativeSupervisorId) return null;
        return this.agents.get(this.nativeSupervisorId)?.tgBot ?? null;
      },
      logger: this.logger,
    });
  }

  /** Start or restart the supervisor heartbeat timer. Delegates to SupervisorManager. */
  private startHeartbeat(intervalMs: number): void {
    this.supervisorManager?.startHeartbeat(intervalMs);
  }

  /** Stop the supervisor heartbeat timer. Delegates to SupervisorManager. */
  private stopHeartbeat(): void {
    this.supervisorManager?.stopHeartbeat();
  }

  /** Push a message from a worker agent into the native supervisor's event queue.
   *  Delegates to SupervisorManager. */
  private pushSupervisorEvent(sourceAgentId: string, text: string, notifyTg = true, forceTg = false, priority: 'routine' | 'high' = 'high'): void {
    this.supervisorManager?.pushEvent(sourceAgentId, text, notifyTg, forceTg, priority);
  }

  /** The effective repo path for session discovery (container agents use a different path). */
  private agentSessionRepo(agent: AgentInstance): string {
    return agent.claudeConfigDir ? '/home/project' : agent.repo;
  }

  /** Repo picker keyboard — final step of the /newcc flow. */
  private async sendExtCcRepoKeyboard(agent: AgentInstance, chatId: number, name: string, worktree: boolean): Promise<void> {
    const kb = new InlineKeyboard();
    Object.keys(this.config.repos).forEach((rn, i) => {
      kb.text(rn, `extcc-repo:${rn}`);
      if (i % 2 === 1) kb.row();
    });
    await agent.tgBot?.sendTextWithKeyboard(
      chatId,
      `<b>${escapeHtml(name)}</b>${worktree ? ' 🌿' : ''} — pick a repo:`,
      kb,
      'HTML',
    );
  }

  /** Create an external CC session (tmux window running `claude --remote-control`) and confirm on TG. */
  private async createExternalCcSession(
    agent: AgentInstance,
    chatId: number,
    name: string,
    opts: { worktree: boolean; repoName: string; repoPath: string },
  ): Promise<void> {
    try {
      const session = this.externalCc.create({ name, repoName: opts.repoName, repoPath: opts.repoPath, worktree: opts.worktree });
      const lines = [
        `🖥 External CC session <b>${escapeHtml(name)}</b> created${opts.worktree ? ' 🌿 (worktree)' : ''}.`,
        `📂 <code>${escapeHtml(opts.repoName)}</code> · tmux <code>${escapeHtml(session.tmuxSession)}</code>`,
        `It will appear in your Claude apps shortly.`,
        `Attach: <code>tmux attach -t ${escapeHtml(session.tmuxSession)}</code>`,
      ];
      await agent.tgBot?.sendText(chatId, `<blockquote>${lines.join('\n')}</blockquote>`, 'HTML');
    } catch (err) {
      this.logger.error({ err, name, ...opts }, 'ExternalCc: create failed');
      await agent.tgBot?.sendText(chatId, `<blockquote>Failed to create external CC session: ${escapeHtml(String(err))}</blockquote>`, 'HTML');
    }
  }

  /** Format ` · {sid8}` or ` · {sid8} "{title}"` for blockquote suffixes. Empty if no session. */
  private formatSessionTag(agent: AgentInstance, sid: string | null | undefined): string {
    if (!sid) return '';
    const short = sid.slice(0, 8);
    let title = this.sessionTitleCache.get(sid);
    if (title === undefined) {
      const jsonlPath = getSessionJsonlPath(sid, this.agentSessionRepo(agent), agent.claudeConfigDir);
      title = readSessionTitle(jsonlPath);
      this.sessionTitleCache.set(sid, title);
    }
    return title ? ` · ${short} "${title}"` : ` · ${short}`;
  }

  /** Discover CC sessions for an agent, using the correct config dir and repo slug. */
  private discoverAgentSessions(agent: AgentInstance, limit = 10): DiscoveredSession[] {
    if (!agent.repo) return [];
    return discoverCCSessions(this.agentSessionRepo(agent), limit, agent.claudeConfigDir);
  }

  /** Send a supervisor message to an agent and register a wake-on-complete ping. Covers both
   *  tgcc_send and an initial tgcc_spawn message — both are one agent directing another. */
  private sendSupervisorMessage(agentId: string, text: string, fromAgentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const summary = text.length > 60 ? text.slice(0, 60) + '…' : text;
    const taggedText = wrapTeammateMessage(fromAgentId, text, summary);

    // Conversation monitor: tag with the source agent and its traced originating human (or
    // "unknown"), BEFORE sendToCC so alreadyMirrored suppresses the generic capture there.
    const sendChatId = this.getAgentChatId(agent);
    if (sendChatId != null) {
      this.monitor.recordInboundSystem(
        agentId,
        sendChatId,
        { kind: 'tgcc_send', fromAgentId, originHuman: this.monitor.resolveOriginHuman(fromAgentId) },
        text,
      );
    }

    this.sendToCC(agentId, { text: taggedText }, { spawnSource: 'supervisor', alreadyMirrored: true });
    if (agent.tgBot) {
      const chatId = this.getAgentChatId(agent);
      if (chatId) {
        const label = `🤖 [${fromAgentId}] ${text}`;
        agent.tgBot.sendText(chatId, `<blockquote>${escapeHtml(label)}</blockquote>`, 'HTML', true)
          .catch(err => this.logger.warn({ err }, 'Failed to notify TG on supervisor send'));
      }
    }
  }

  /** Deliver a fired cron job's message to its target agent, tagging it for the conversation
   *  monitor as ⏰ cron (rather than falling into sendToCC's generic 🧭 supervisor bucket) before
   *  the shared static/dynamic cron callback hands off to sendToCC. */
  private sendCronMessage(agentId: string, text: string): void {
    const agent = this.agents.get(agentId);
    const chatId = agent ? this.getAgentChatId(agent) : null;
    if (chatId != null) {
      this.monitor.recordInboundSystem(agentId, chatId, { kind: 'cron' }, text);
    }
    this.sendToCC(agentId, { text }, { spawnSource: 'supervisor', alreadyMirrored: true });
  }

  // ── Cron isolated spawn ──

  private spawnCronIsolated(job: CronJobConfig): void {
    const agentConfig = this.config.agents[job.agentId];
    if (!agentConfig) {
      this.logger.warn({ jobId: job.id, agentId: job.agentId }, 'Cron job: target agent not found');
      return;
    }
    const cronAgentId = `cron:${job.id}:${Date.now()}`;
    this.logger.info({ jobId: job.id, cronAgentId }, 'Spawning isolated cron agent');
    // Reuse ephemeral agent path via MCP spawn
    const model = job.model ?? agentConfig.defaults.model;
    const timeoutMs = job.timeoutMs ?? 120_000;
    // Create an ephemeral agent and immediately send the job message
    this.handleMcpToolRequest({
      id: `cron-spawn-${job.id}`,
      agentId: job.agentId, // source = the target agent's context (repo etc.)
      userId: 'cron',
      tool: 'tgcc_spawn',
      params: {
        agentId: cronAgentId,
        model,
        timeoutMs,
        repo: agentConfig.defaults.repo,
        message: job.message,
      },
    }).catch(err => this.logger.error({ err, jobId: job.id }, 'Failed to spawn isolated cron agent'));
  }

  // ── Audio / video transcription ──
  //
  // Gemini is the default and only transcription path (no ffmpeg dependency — it takes
  // audio/video inline; never forces a language, so it works for an EN/ES household).
  // Whisper is kept as an opt-in fallback only (TGCC_WHISPER_FALLBACK=true), tried only when
  // Gemini genuinely failed (not when it succeeded with an empty/no-speech transcript), and
  // never for video_note. See linds.ai-chat/_specs/BACKLOG.md §4.

  private async resolveWhisperBin(): Promise<string | null> {
    if (this.whisperBin !== undefined) return this.whisperBin;
    const execAsync = promisify(nodeExec);
    // Try PATH first, then known Homebrew location
    const candidates = ['whisper', '/home/linuxbrew/.linuxbrew/bin/whisper'];
    for (const bin of candidates) {
      try {
        await execAsync(`test -x "$(which ${bin} 2>/dev/null || echo ${bin})" 2>/dev/null || test -x "${bin}"`);
        this.whisperBin = bin;
        return bin;
      } catch { /* try next */ }
    }
    this.whisperBin = null;
    return null;
  }

  /** Opt-in Whisper fallback. Returns null if Whisper isn't available or fallback isn't enabled
   *  (caller keeps the original Gemini failure in that case). Never forces a language — the
   *  hardcoded `--language en` was the reason this was unfit for an EN/ES household even when
   *  the binary worked. */
  private async tryWhisperFallback(filePath: string, fileName: string): Promise<TranscribeResult | null> {
    if (process.env.TGCC_WHISPER_FALLBACK !== 'true') return null;

    const whisper = await this.resolveWhisperBin();
    if (!whisper) {
      this.logger.warn({ filePath }, 'Whisper fallback enabled but binary not found');
      return null;
    }

    const outDir = '/tmp/tgcc/whisper';
    const model = 'whisper-small';
    try {
      mkdirSync(outDir, { recursive: true });
      const execAsync = promisify(nodeExec);
      this.logger.info({ filePath }, 'Whisper fallback: transcribing');
      // 30s cap — matches the Gemini timeout. There was no timeout on this call before, which
      // could hang a turn indefinitely on a long note.
      await execAsync(`"${whisper}" "${filePath}" --model small --output_format txt --output_dir "${outDir}"`, { timeout: 30_000 });

      const baseName = fileName.replace(/\.[^.]+$/, '');
      const txtPath = join(outDir, `${baseName}.txt`);
      if (!existsSync(txtPath)) {
        return { ok: false, text: null, truncated: false, model, provider: 'whisper', error: 'Whisper output file not found' };
      }
      const transcript = readFileSync(txtPath, 'utf-8').trim();
      return { ok: true, text: transcript || null, truncated: false, model, provider: 'whisper' };
    } catch (err) {
      const e = err as Error;
      this.logger.error({ err: e, filePath }, 'Whisper fallback failed');
      return { ok: false, text: null, truncated: false, model, provider: 'whisper', error: e.message };
    }
  }

  /** Kind label for the injected turn, matching BACKLOG.md §4c/4d examples. */
  private static transcribableKind(type: TelegramMessage['type']): string {
    if (type === 'voice') return 'Voice note';
    if (type === 'video_note') return 'Video note';
    return 'Audio';
  }

  /**
   * Transcribe a voice note, forwarded audio file, or video note, then route the result through
   * the normal message path (reply context, group attribution/roster, MessageBatcher) exactly
   * like a text message — this was the routing bug: voice used to call sendToCC directly,
   * skipping all of that. The file path stays embedded in the injected text (not on
   * BatcherMessage.filePath/fileName) so the transcript is treated as plain text for batching
   * purposes and doesn't trigger the immediate-flush-on-attachment branch, letting it coalesce
   * with a fast follow-up text message.
   */
  private async transcribeMedia(agentId: string, msg: TelegramMessage): Promise<void> {
    if (!msg.filePath || !msg.fileName) return;
    const kind = Bridge.transcribableKind(msg.type);

    let result: TranscribeResult;
    if (msg.audioBase64) {
      result = await transcribeAudioGemini(msg.audioBase64, msg.mimeType ?? 'audio/ogg', this.logger);
    } else {
      result = {
        ok: false,
        text: null,
        truncated: false,
        model: process.env.TRANSCRIBE_MODEL || 'gemini-2.5-flash',
        provider: 'gemini',
        error: 'No audio data captured from Telegram',
      };
    }

    // Only fall back to Whisper on a genuine failure — never for a legitimate empty transcript,
    // and never for video (Whisper doesn't decode video containers here).
    if (!result.ok && msg.type !== 'video_note') {
      const fallback = await this.tryWhisperFallback(msg.filePath, msg.fileName);
      if (fallback) result = fallback;
    }

    const text = buildTranscriptionTurn({
      senderName: msg.userName,
      durationSec: msg.durationSec,
      filePath: msg.filePath,
      kind,
      result,
    });

    this.logger.info({ agentId, kind, ok: result.ok, provider: result.provider, truncated: result.truncated }, 'Transcription complete');
    this.queueForChat(agentId, { ...msg, text });
  }

  // ── Startup ──

  async start(): Promise<void> {
    this.logger.info('Starting bridge');

    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      await this.startAgent(agentId, agentConfig);
    }

    // Wire up the announce callback for cron TG notifications
    this.scheduler.setAnnounceFn((annAgentId, annText) => {
      const annAgent = this.agents.get(annAgentId);
      if (!annAgent?.tgBot) return;
      const annChatId = this.getAgentChatId(annAgent);
      if (annChatId) {
        annAgent.tgBot.sendText(annChatId, `<blockquote>${annText}</blockquote>`, 'HTML', true)
          .catch(err => this.logger.warn({ err, agentId: annAgentId }, 'Failed to send cron announce'));
      }
    });

    // Start static cron jobs (config-level, shared across agents)
    if (this.config.cron?.jobs.length) {
      this.scheduler.startAllCronJobs(
        this.config.cron.jobs,
        (agentId, text) => this.sendCronMessage(agentId, text),
        (job) => this.spawnCronIsolated(job),
      );
    }

    // Load persisted dynamic cron jobs
    const validAgentIds = new Set(Object.keys(this.config.agents));
    this.scheduler.loadDynamicJobs(
      (agentId, text) => this.sendCronMessage(agentId, text),
      (job) => this.spawnCronIsolated(job),
      validAgentIds,
    );

    // Restore persisted ralphs (re-create ephemeral agents and re-spawn with fresh prompt)
    await this.restoreRalphs();

    // Set up config-based persistent tracking (agent.tracks → WatcherManager)
    this.setupPersistentTracking();

    this.logger.info({ agents: Object.keys(this.config.agents) }, 'Bridge started');

    // Emit bridge_started event to supervisor
    this.sendToSupervisor({
      type: 'event',
      event: 'bridge_started',
      agents: Object.keys(this.config.agents),
      uptime: 0,
    });

    // Auto-resume sessions from before the restart
    this.autoResumeSessions();
  }

  /**
   * Auto-resume sessions for all agents after a TGCC restart.
   * For each agent, finds the most recent session and:
   * - If it ended cleanly: sets pendingSessionId so next interaction resumes it
   * - If it was interrupted mid-turn: sets pendingSessionId AND sends a nudge to continue
   */
  private autoResumeSessions(): void {
    const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours — same as spawn logic
    const now = Date.now();

    for (const [agentId, agent] of this.agents) {
      if (agent.ephemeral) continue;
      if (!agent.repo) continue;

      try {
        // Prefer per-chat tracked sessions (state.json) over JSONL-mtime discovery.
        // Picking by mtime is wrong here: other JSONLs in the same project dir
        // (subagents, ralph, a CLI session, a forked session) routinely outrank the
        // chat's actual session, and after one wrong pick `init` overwrites the
        // chat's tracking in state.json — the original session is lost forever.
        const agentState = this.sessionStore.getAgent(agentId);
        const tracked = Object.entries(agentState.sessionsByChat ?? {});

        let resumedAnyChat = false;
        for (const [chatIdStr, sessionId] of tracked) {
          const chatId = Number(chatIdStr);
          const jsonlPath = getSessionJsonlPath(sessionId, this.agentSessionRepo(agent), agent.claudeConfigDir);
          if (!existsSync(jsonlPath)) {
            this.logger.info({ agentId, chatId, sessionId }, 'Auto-resume: tracked JSONL missing — clearing tracking');
            this.sessionStore.clearSessionForChat(agentId, chatId);
            continue;
          }
          const st = statSync(jsonlPath);
          if (isRemoteControlSession(jsonlPath, st.size)) {
            // A tracked entry can be poisoned the same way legacy lastSessionId was: a
            // human's interactive `claude`/`--remote-control` session (or a `/newcc`
            // external session) sharing this agent's project dir got written into
            // sessionsByChat. Discovery-side filtering (discoverCCSessions) never runs
            // for tracked ids, so without this check a poisoned entry gets silently
            // re-resumed — and re-nudged — on every restart forever.
            this.logger.warn({ agentId, chatId, sessionId }, 'Auto-resume: tracked session is a foreign remote-control session — clearing tracking');
            this.sessionStore.clearSessionForChat(agentId, chatId);
            continue;
          }
          const ageMs = now - st.mtimeMs;
          if (ageMs > STALE_MS) {
            this.logger.info({ agentId, chatId, sessionId, ageMs }, 'Auto-resume: tracked session too old — skipping');
            continue;
          }
          const endState = getSessionEndState(jsonlPath, st.size);

          const cs = getOrCreateChatSession(agent, chatId);
          cs.pendingSessionId = sessionId;
          cs.forceNewSession = false;
          resumedAnyChat = true;

          this.logger.info({ agentId, chatId, sessionId, endState, ageMs }, 'Auto-resume: tracked session prepared');

          if (endState === 'interrupted') {
            this.logger.info({ agentId, chatId, sessionId }, 'Auto-resume: sending nudge for interrupted tracked session');
            this.sendToCC(agentId, {
              text: wrapSystemReminder('TGCC restarted while you were mid-turn. Your previous session has been resumed. Continue where you left off.'),
            }, { chatId });
          }
        }

        if (resumedAnyChat) continue;

        // Fallback: no per-chat tracking yet. This is legitimate ONLY for an agent that
        // predates the per-chat refactor and still carries a `lastSessionId` from the old
        // single-session-per-agent model — resume exactly that recorded session, nothing
        // else. Do NOT discover-by-mtime here: the project directory is shared with
        // interactive `claude` sessions, `/newcc` external CC sessions, and other TGCC
        // agents pointed at the same repo. Picking "the newest JSONL" would silently and
        // permanently adopt whichever one of those happens to sort first — the moment
        // `init` fires, it gets written into sessionsByChat forever (this is exactly how
        // the color agent ended up hijacking an unrelated interactive session).
        const legacySessionId = agentState.lastSessionId;
        if (!legacySessionId) continue;

        const jsonlPath = getSessionJsonlPath(legacySessionId, this.agentSessionRepo(agent), agent.claudeConfigDir);
        if (!existsSync(jsonlPath)) {
          this.logger.info({ agentId, sessionId: legacySessionId }, 'Auto-resume: legacy lastSessionId JSONL missing — skipping');
          continue;
        }
        if (isRemoteControlSession(jsonlPath)) {
          this.logger.warn({ agentId, sessionId: legacySessionId }, 'Auto-resume: legacy lastSessionId is a foreign remote-control session — skipping');
          continue;
        }
        const st = statSync(jsonlPath);
        const ageMs = now - st.mtimeMs;
        if (ageMs > STALE_MS) {
          this.logger.info({ agentId, sessionId: legacySessionId, ageMs }, 'Auto-resume: legacy lastSessionId too old — skipping');
          continue;
        }

        const resumeChatId = this.getAgentChatId(agent);
        if (resumeChatId == null) {
          this.logger.info({ agentId, sessionId: legacySessionId }, 'Auto-resume: no chat to attach legacy session — skipping');
          continue;
        }
        const endState = getSessionEndState(jsonlPath, st.size);
        const cs = getOrCreateChatSession(agent, resumeChatId);
        cs.pendingSessionId = legacySessionId;
        cs.forceNewSession = false;

        this.logger.info({ agentId, sessionId: legacySessionId, endState, ageMs }, 'Auto-resume: legacy lastSessionId prepared (pre-per-chat migration)');

        if (endState === 'interrupted') {
          this.logger.info({ agentId, sessionId: legacySessionId }, 'Auto-resume: sending nudge for interrupted legacy session');
          this.sendToCC(agentId, {
            text: wrapSystemReminder('TGCC restarted while you were mid-turn. Your previous session has been resumed. Continue where you left off.'),
          }, { chatId: resumeChatId });
        }
      } catch (err) {
        this.logger.error({ err, agentId }, 'Auto-resume failed for agent');
      }
    }
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
      agentId === this.nativeSupervisorId,
    );

    // Resolve initial repo and model from config + persisted state
    const agentState = this.sessionStore.getAgent(agentId);
    const configDefaults = agentConfig.defaults;

    const instance: AgentInstance = {
      id: agentId,
      config: agentConfig,
      tgBot,
      ephemeral: false,
      repo: agentState.repo || configDefaults.repo,
      model: agentState.model || configDefaults.model,
      chatSessions: new Map(),
      pendingPermissions: new Map(),
      pendingExecApprovals: new Map(),
      lastTgChatId: null,
      lastTgUserId: null,
      destroyTimer: null,
      eventBuffer: new EventBuffer(),
      awaitingAskCleanup: false,
      muteOutput: false,
      authFlowInProgress: false,
      lastSendData: null,
      claudeConfigDir: agentConfig.share
        ? join(homedir(), '.tgcc', 'agents', agentId, 'repos', computeProjectSlug(agentState.repo || configDefaults.repo), '.claude')
        : undefined,
      pendingCliTmuxAgent: null,
    };

    this.agents.set(agentId, instance);
    await tgBot.start();

    // Start heartbeat if configured
    if (agentConfig.heartbeat) {
      this.scheduler.startHeartbeat(
        agentId,
        agentConfig.heartbeat,
        () => this.agentIsIdle(agentId),
        (aid) => {
          const a = this.agents.get(aid);
          if (!a) return;
          const repo = a.repo;
          if (!repo) return;
          const hbPath = join(repo, 'HEARTBEAT.md');
          let hbContent: string;
          try { hbContent = readFileSync(hbPath, 'utf-8').trim(); } catch { return; }
          if (!hbContent) return;
          // Always mute TG rendering — CC reports via send_message tool if needed
          a.muteOutput = true;
          const text = `<heartbeat_rules>
This is a background heartbeat. Your normal text output is NOT visible to the user.
The ONLY way to communicate with the user is by calling the send_message MCP tool.
You MUST call send_message if:
- Any tool call fails or returns an error
- There are unanswered messages, alerts, or items needing attention
- Anything unexpected happens
Only stay silent if every check passes cleanly with no issues.
</heartbeat_rules>

${hbContent}`;
          this.sendToCC(aid, { text }, { spawnSource: 'supervisor' });
        },
      );
    }

    // Start control socket for CLI access
    const ctlSocketPath = join(this.config.global.ctlSocketDir, `${agentId}.sock`);
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
        // Propagate to TelegramBot (clears rejection cache, bootstraps new group rosters)
        oldAgent.tgBot?.updateConfig(newAgentConfig);
      }
    }

    // Restart heartbeats for changed agents
    for (const agentId of diff.changed) {
      const newAgentConfig = newConfig.agents[agentId];
      if (!newAgentConfig) continue;
      this.scheduler.stopHeartbeat(agentId);
      if (newAgentConfig.heartbeat) {
        this.scheduler.startHeartbeat(
          agentId,
          newAgentConfig.heartbeat,
          () => this.agentIsIdle(agentId),
          (aid) => {
            const a = this.agents.get(aid);
            if (!a) return;
            const repo = a.repo;
            if (!repo) return;
            const hbPath = join(repo, 'HEARTBEAT.md');
            let hbContent: string;
            try { hbContent = readFileSync(hbPath, 'utf-8').trim(); } catch { return; }
            if (!hbContent) return;
            a.muteOutput = true;
            const text = `<heartbeat_rules>
This is a background heartbeat. Your normal text output is NOT visible to the user.
The ONLY way to communicate with the user is by calling the send_message MCP tool.
You MUST call send_message if:
- Any tool call fails or returns an error
- There are unanswered messages, alerts, or items needing attention
- Anything unexpected happens
Only stay silent if every check passes cleanly with no issues.
</heartbeat_rules>

${hbContent}`;
            this.sendToCC(aid, { text }, { spawnSource: 'supervisor' });
          },
        );
      }
    }

    // Restart cron jobs if config changed (static only — dynamic are preserved)
    this.scheduler.stopAllCronJobs();
    if (newConfig.cron?.jobs.length) {
      this.scheduler.startAllCronJobs(
        newConfig.cron.jobs,
        (agentId, text) => this.sendCronMessage(agentId, text),
        (job) => this.spawnCronIsolated(job),
      );
    }
    // Re-load dynamic cron jobs (they survive config reload)
    const reloadValidAgentIds = new Set(Object.keys(newConfig.agents));
    this.scheduler.loadDynamicJobs(
      (agentId, text) => this.sendCronMessage(agentId, text),
      (job) => this.spawnCronIsolated(job),
      reloadValidAgentIds,
    );

    this.config = newConfig;
  }

  private async stopAgent(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    this.logger.info({ agentId, ephemeral: agent.ephemeral }, 'Stopping agent');

    // Stop heartbeat if running
    this.scheduler.stopHeartbeat(agentId);

    // Stop bot (persistent agents only)
    if (agent.tgBot) await agent.tgBot.stop();

    // Clear auto-destroy timer (ephemeral agents)
    if (agent.destroyTimer) {
      clearTimeout(agent.destroyTimer);
      agent.destroyTimer = null;
    }

    // Kill every chat's CC process and clean up its per-chat state
    for (const cs of agent.chatSessions.values()) {
      const proc = cs.ccProcess;
      if (proc) {
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
      }
      // Cancel batcher
      if (cs.batcher) {
        cs.batcher.cancel();
        cs.batcher.destroy();
      }
      // Clean up accumulator
      if (cs.accumulator) {
        cs.accumulator.finalize();
        cs.accumulator = null;
      }
      // Clean up sub-agent tracker
      if (cs.subAgentTracker) {
        cs.subAgentTracker.reset();
        cs.subAgentTracker = null;
      }
      // Clear typing indicator
      if (cs.typingInterval) {
        clearInterval(cs.typingInterval);
        cs.typingInterval = null;
      }
      cs.ccProcess = null;
      cs.batcher = null;
    }
    agent.chatSessions.clear();

    // Unsubscribe from registry
    const clientRef: ClientRef = { agentId, userId: agentId, chatId: 0 };
    this.processRegistry.unsubscribe(clientRef);

    // Close MCP socket
    const socketPath = join(this.config.global.socketDir, `${agentId}.sock`);
    this.mcpServer.close(socketPath);

    agent.pendingPermissions.clear();
    for (const [id, pending] of agent.pendingExecApprovals) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    agent.pendingExecApprovals.clear();

    // Close control socket
    const ctlSocketPath = join(this.config.global.ctlSocketDir, `${agentId}.sock`);
    this.ctlServer.close(ctlSocketPath);

    this.agents.delete(agentId);
  }

  // ── Message handling ──

  private handleTelegramMessage(agentId: string, msg: TelegramMessage): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // The conversation-monitor destination chat is a one-way mirror feed, not a conversation.
    // The owner has to be an allowed user for whichever bot posts there (to run /monitor_here),
    // and that bot has to be a group admin to manage topics, so it receives every message in
    // that chat — without this guard, anything typed there (a note, a reply to a mirrored
    // message) would be treated as a prompt and spawn a CC turn inside the feed itself. Slash
    // commands are unaffected (routed separately via onCommand/handleSlashCommand, which applies
    // its own allowlist for this chat). Only applies to a GROUP destination on the supervisor's
    // bot specifically — see isMonitorDestinationChat for why a private-chat destination must
    // never trigger this (Telegram private chat ids are the user's id, identical across every
    // bot, so this would otherwise lock the owner out of every agent whenever the destination is
    // a DM).
    if (this.isMonitorDestinationChat(agentId, msg.chatId)) return;

    this.logger.debug({ agentId, userId: msg.userId, type: msg.type }, 'TG message received');

    // Check if this text is an "Other" answer for a pending AskUserQuestion
    if (msg.text) {
      for (const [reqId, pending] of agent.pendingPermissions) {
        if (pending.toolName === 'AskUserQuestion' && pending.awaitingTextQIdx !== undefined) {
          const qi = pending.awaitingTextQIdx;
          const questions = (pending.input?.questions ?? []) as AskQuestion[];
          const answers = { ...(pending.questionAnswers ?? {}), [String(qi)]: [msg.text] };
          const allAnswered = questions.every((_, i) => answers[String(i)]?.length);
          if (allAnswered) {
            const askProc = pending.questionChatId != null
              ? getChatSession(agent, pending.questionChatId)?.ccProcess
              : undefined;
            this.submitAskAnswer(agentId, pending, askProc ?? null, questions, answers);
            agent.pendingPermissions.delete(reqId);
            if (pending.questionMsgId && pending.questionChatId) {
              const summary = questions.map((q, i) => `<b>${escapeHtml(q.question)}</b>\n→ ${escapeHtml(answers[String(i)]?.[0] ?? '')}`).join('\n\n');
              agent.tgBot?.editText(pending.questionChatId, pending.questionMsgId, `❓ ${summary}`, 'HTML').catch(() => {});
            }
          } else {
            pending.questionAnswers = answers;
            pending.awaitingTextQIdx = undefined;
            if (pending.questionMsgId && pending.questionChatId) {
              const { text: uiText, keyboard } = buildAskUi(reqId, questions, answers);
              agent.tgBot?.editTextWithKeyboard(pending.questionChatId, pending.questionMsgId, uiText, keyboard, 'HTML').catch(() => {});
            }
          }
          return; // don't forward to CC
        }
      }
    }

    // Handle pending /new-cli tmux session name reply
    if (agent.pendingCliTmuxAgent && msg.text) {
      const tmuxName = msg.text.trim().replace(/[^a-zA-Z0-9_-]/g, '');
      const targetAgent = agent.pendingCliTmuxAgent;
      agent.pendingCliTmuxAgent = null;
      if (!tmuxName) {
        agent.tgBot?.sendText(msg.chatId, '<blockquote>Invalid session name. Use alphanumeric characters only.</blockquote>', 'HTML').catch(() => {});
        return;
      }
      // Use the system-installed `tgcc` binary (in PATH) — NOT `process.argv[1]`,
      // which is the relative non-executable `dist/cli.js` under systemd.
      try {
        execSync(`tmux new-session -d -s ${JSON.stringify(tmuxName)} "tgcc attach --agent ${targetAgent}"`, { stdio: 'ignore' });
        agent.tgBot?.sendText(
          msg.chatId,
          `<blockquote>CLI session created in new tmux session <code>${escapeHtml(tmuxName)}</code>.\nAttach: <code>tmux attach -t ${escapeHtml(tmuxName)}</code></blockquote>`,
          'HTML',
        ).catch(() => {});
      } catch (err) {
        agent.tgBot?.sendText(msg.chatId, `<blockquote>Failed to create tmux session: ${escapeHtml(String(err))}</blockquote>`, 'HTML').catch(() => {});
      }
      return;
    }

    // Voice notes, forwarded audio files, and video notes: transcribe (Gemini, with an opt-in
    // Whisper fallback) before forwarding. Routed through queueForChat like any other message —
    // this used to call sendToCC directly, skipping reply-context, group attribution/roster,
    // and the MessageBatcher entirely.
    if (msg.type === 'voice' || msg.type === 'audio' || msg.type === 'video_note') {
      this.transcribeMedia(agentId, msg).catch(err => {
        // Last-resort net: transcribeMedia/transcribeAudioGemini should never throw (every
        // failure mode is captured in TranscribeResult), but if something truly unexpected
        // happens, still fail loudly rather than silently dropping the note.
        this.logger.error({ err, agentId }, 'Transcription pipeline threw unexpectedly');
        const kind = Bridge.transcribableKind(msg.type);
        const text = `[${kind} — transcription FAILED: ${(err as Error)?.message ?? String(err)}. Audio at ${msg.filePath}; you may transcribe it yourself.]`;
        this.queueForChat(agentId, { ...msg, text });
      });
      return;
    }

    this.queueForChat(agentId, msg);
  }

  /**
   * Shared routing tail for every inbound Telegram message: per-chat batcher, reply context,
   * and group attribution + roster injection. `msg.text` is used verbatim — callers (including
   * transcribeMedia) are responsible for having already built the final text.
   */
  private queueForChat(agentId: string, msg: TelegramMessage): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Conversation monitor: capture the raw inbound message (full sender identity, pre-batching,
    // pre-roster-injection) — the single point where both are available together. A no-op when
    // the monitor is off or this agent isn't in monitor.agents.
    this.monitor.recordInboundTelegram(
      agentId,
      {
        userId: msg.userId,
        userName: msg.userName,
        userHandle: msg.userHandle,
        chatId: msg.chatId,
        isGroup: msg.chatId < 0,
        chatTitle: msg.chatTitle,
      },
      { kind: msg.type, text: msg.text, fileName: msg.fileName },
    );

    // Ensure a per-chat batcher exists — each chat batches independently.
    agent.lastTgChatId = msg.chatId;
    agent.lastTgUserId = msg.userId ? Number(msg.userId) : null;
    const cs = getOrCreateChatSession(agent, msg.chatId);
    if (!cs.batcher) {
      cs.batcher = new MessageBatcher(2000, (combined) => {
        this.sendToCC(agentId, combined, { chatId: msg.chatId, spawnSource: 'telegram' });
      });
    }

    // Prepare text with reply context and group attribution
    const roster = agent.tgBot?.getGroupRoster(msg.chatId) ?? null;
    const text = buildInboundText(
      { text: msg.text, replyToText: msg.replyToText, chatId: msg.chatId, userName: msg.userName, userHandle: msg.userHandle },
      roster,
      agent.config.groupContext,
    );

    // Transcribed media already has its audio path embedded in the text (see
    // buildTranscriptionTurn) — don't also pass filePath/fileName through, or sendToCC's
    // createDocumentMessage branch would append a second, redundant "[Attached file: ...]" line
    // and (more importantly) the MessageBatcher would flush it immediately instead of using the
    // normal 2s window, so it could never coalesce with a fast follow-up text message.
    const isTranscribedMedia = msg.type === 'voice' || msg.type === 'audio' || msg.type === 'video_note';

    cs.batcher.add({
      text,
      imageBase64: msg.imageBase64,
      imageMediaType: msg.imageMediaType,
      filePath: isTranscribedMedia ? undefined : msg.filePath,
      fileName: isTranscribedMedia ? undefined : msg.fileName,
      mediaGroupId: msg.mediaGroupId,
    });
  }

  private async sendToCC(
    agentId: string,
    data: { text: string; imageBase64?: string; imageMediaType?: string; images?: Array<{ base64: string; mediaType: string }>; filePath?: string; fileName?: string },
    source?: { chatId?: number; spawnSource?: 'telegram' | 'supervisor' | 'cli'; alreadyMirrored?: boolean }
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // Resolve the chat this message belongs to and its per-chat session state.
    const chatId = source?.chatId ?? this.getAgentChatId(agent);
    if (chatId == null) {
      this.logger.warn({ agentId }, 'sendToCC: no chat ID resolvable — dropping message');
      return;
    }
    const cs = getOrCreateChatSession(agent, chatId);

    // Conversation monitor: capture every non-Telegram-originated turn (Telegram-originated ones
    // are already captured earlier in queueForChat, with richer sender identity than survives
    // batching). Callers that already mirrored this turn themselves with a more specific tag
    // (tgcc_send, cron, ralph — see sendSupervisorMessage / sendCronMessage / the ralph prompt
    // send) set alreadyMirrored so it isn't double-recorded under a generic label here.
    if (source?.spawnSource !== 'telegram' && !source?.alreadyMirrored) {
      const origin: TurnOrigin = source?.spawnSource === 'cli' ? { kind: 'cli' } : { kind: 'supervisor' };
      this.monitor.recordInboundSystem(agentId, chatId, origin, data.text);
    }

    // If a CLI session is attached, yank it: TG always wins. Pass the CLI's sessionId
    // through pendingSessionId so the new stdin CC resumes the same conversation.
    if (this.ctlServer.hasCliSession(agentId)) {
      const yankedSessionId = cs.cliSessionId;
      this.logger.info({ agentId, yankedSessionId }, 'TG message arrived — yanking CLI session');
      if (yankedSessionId && !cs.pendingSessionId) {
        cs.pendingSessionId = yankedSessionId;
      }
      cs.cliSessionId = null;
      this.ctlServer.sendToCliSocket(agentId, { type: 'cli_kill' });
      if (agent.tgBot) {
        agent.tgBot.sendText(chatId, '<blockquote>⚡ CLI session yanked — TG taking over.</blockquote>', 'HTML', true)
          .catch(err => this.logger.warn({ err }, 'Failed to send CLI yank notification'));
      }
      // Fall through — normal stdin spawn logic below will start CC fresh and resume the session
    }

    // Clear mute if this is a user-facing send (not a wake ping)
    if (source?.spawnSource !== 'supervisor') {
      agent.muteOutput = false;
    }

    // Save for potential auth retry
    agent.lastSendData = { text: data.text, source };

    // Construct CC message
    let text = data.text;

    // Prepend IDE awareness context to the first message after an IDE session takeover
    if (cs.pendingIdeAwareness) {
      cs.pendingIdeAwareness = false;
      text = `${wrapSystemReminder('This session was recently active in an IDE (VSCode). IDE messages are in your conversation history but may not appear in this Telegram chat.')}\n\n${text}`;
    }

    // Supervisor receiving a real user message — flush accumulated routine worker telemetry
    // (turn-complete, spawn, ephemeral create/destroy) as FYI context so the supervisor can
    // see what its workers have been doing since the last user interaction.
    if (agentId === this.nativeSupervisorId && source?.spawnSource === 'telegram') {
      const routine = this.supervisorManager?.flushPendingRoutine();
      if (routine) text = `${routine}\n\n${text}`;
    }

    let ccMsg;
    if (data.images && data.images.length > 0) {
      ccMsg = createMultiImageMessage(text, data.images);
    } else if (data.imageBase64) {
      ccMsg = createImageMessage(
        text,
        data.imageBase64,
        data.imageMediaType as 'image/jpeg' | undefined,
      );
    } else if (data.filePath && data.fileName) {
      ccMsg = createDocumentMessage(text, data.filePath, data.fileName);
    } else {
      ccMsg = createTextMessage(text);
    }

    let proc = cs.ccProcess;

    if (proc?.takenOver) {
      // Session was taken over externally — discard old process
      const entry = this.processRegistry.findByProcess(proc);
      if (entry) this.processRegistry.destroy(entry.repo, entry.sessionId);
      cs.ccProcess = null;
      proc = null;
    }

    // Container agents can reuse their idle process (relay keeps CC alive between turns)
    const isContainerIdle = proc?.state === 'idle' && agent.config.share?.mode === 'docker';

    if (!proc || (proc.state === 'idle' && !isContainerIdle)) {
      // Warn if no repo is configured
      if (agent.repo === homedir() && agent.tgBot) {
        agent.tgBot.sendText(
          chatId,
          formatSystemMessage('status', 'No project selected. Use /repo to pick one, or CC will run in your home directory.'),
          'HTML',
          true, // silent
        ).catch(err => this.logger.error({ err }, 'Failed to send no-repo warning'));
      }

      // Notify if spawning a genuinely stale session (no pending session, last activity >2h ago,
      // and activity was during this run — not a restart scenario already notified at shutdown)
      if (!cs.pendingSessionId) {
        const agentState = this.sessionStore.getAgent(agentId);
        const lastActivityMs = new Date(agentState.lastActivity).getTime();
        const isStale = Date.now() - lastActivityMs >= 2 * 60 * 60 * 1000;
        const isFromThisRun = lastActivityMs >= this.startedAt;
        if (isStale && isFromThisRun) {
          if (agent.tgBot) {
            agent.tgBot.sendText(chatId, '<blockquote>Starting a new session. Use /sessions to resume a previous one.</blockquote>', 'HTML', true)
              .catch(err => this.logger.error({ err }, 'Failed to send stale session notification'));
          }
        } else if (!isStale && cs.forceNewSession) {
          // Process exited (restart, crash, etc.) — notify that a new session is starting
          if (agent.tgBot) {
            agent.tgBot.sendText(chatId, '<blockquote>Previous session ended. Starting fresh.</blockquote>', 'HTML', true)
              .catch(err => this.logger.error({ err }, 'Failed to send forceNewSession notification'));
          }
        } else if (!isStale && !cs.forceNewSession) {
          // Auto-continuing a recent session — check if it came from an IDE (e.g. VSCode)
          if (agent.tgBot) {
            const recent = this.discoverAgentSessions(agent, 1);
            if (recent.length > 0) {
              const jsonlPath = getSessionJsonlPath(recent[0].id, this.agentSessionRepo(agent), agent.claudeConfigDir);
              if (hasIDEContent(jsonlPath)) {
                agent.tgBot.sendText(chatId, formatSystemMessage('status', 'Resuming a session previously active in VSCode IDE.'), 'HTML', true)
                  .catch(err => this.logger.error({ err }, 'Failed to send IDE origin notification'));
                cs.pendingIdeAwareness = true;
              }
            }
          }
        }
      }

      // Explicit session resume — also check for IDE origin
      if (cs.pendingSessionId && !cs.forceNewSession) {
        if (agent.tgBot) {
          const jsonlPath = getSessionJsonlPath(cs.pendingSessionId, agent.repo);
          if (hasIDEContent(jsonlPath)) {
            agent.tgBot.sendText(chatId, formatSystemMessage('status', 'Resuming a session previously active in VSCode IDE.'), 'HTML', true)
              .catch(err => this.logger.error({ err }, 'Failed to send IDE origin notification'));
            cs.pendingIdeAwareness = true;
          }
        }
      }

      proc = this.spawnCCProcess(agentId, chatId);
      cs.ccProcess = proc;

      // Emit cc_spawned event to supervisor
      const spawnSource = source?.spawnSource ?? 'telegram';
      this.logger.info({ agentId, sessionId: proc.sessionId, source: spawnSource }, 'CC process spawned');
      if (this.isSupervisorSubscribed(agentId, proc.sessionId)) {
        this.sendToSupervisor({
          type: 'event',
          event: 'cc_spawned',
          agentId,
          sessionId: proc.sessionId,
          source: spawnSource,
        });
      }
      // Native supervisor: notify if worker is tracked
      if (this.supervisorManager?.isTracked(agentId)) {
        this.pushSupervisorEvent(agentId, `🚀 Spawned (${spawnSource})`, true, false, 'routine');
      }
    }

    // Show typing indicator
    this.startTypingIndicator(agent, chatId);

    // Log user message in event buffer
    agent.eventBuffer.push({ ts: Date.now(), type: 'user', text: data.text });

    // If CC is mid-turn, fully drain pending content into the current bubble before reset,
    // so the truncated bubble reflects exactly what CC produced up to this moment. CC keeps
    // emitting events during the await; a single flush captures only the snapshot at call
    // time, so we loop briefly — yielding the event loop between passes lets queued
    // handleEvent calls update segments before the next flush captures them.
    if (proc.state === 'active' && cs.accumulator) {
      const acc = cs.accumulator;
      for (let i = 0; i < 3; i++) {
        await acc.flushIfDirty();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      acc.reset();
    }

    // User wrote again instead of clicking an AskUserQuestion keyboard — discard
    // the pending question so CC unblocks and processes this new turn. Must go
    // out BEFORE the new user message: deny is a control_response, the message
    // is a user input — both hit stdin, order is preserved by the stream.
    this.cancelPendingAskUserQuestions(agent, chatId, proc);

    proc.sendMessage(ccMsg);
  }

  /**
   * Deliver AskUserQuestion answers back to the worker.
   *
   * Three paths:
   *  - `can_use_tool` permission flow (no toolUseId): we must reply via the live
   *    process's `control_response` channel — there's no fallback if the process
   *    is gone, the request just expires.
   *  - `requiresUserInteraction=true` tool-result flow (has toolUseId): CC rejected
   *    the tool before we could respond, so the answer is delivered as a fresh user
   *    turn. Use `sendToCC` so it spawns the worker if it had exited between the
   *    question being posted and the user tapping the keyboard.
   */
  private submitAskAnswer(
    agentId: string,
    pending: PendingPermission,
    proc: ICCProcess | null,
    questions: AskQuestion[],
    answers: Record<string, string[]>,
  ): void {
    if (!pending.toolUseId) {
      if (proc) {
        const builtAnswers = buildAskAnswers(questions, answers);
        proc.respondToPermission(pending.requestId, true, { questions, answers: builtAnswers });
      } else {
        this.logger.warn({ agentId, reqId: pending.requestId }, 'AskUserQuestion permission expired — no live CC to respond to');
      }
      return;
    }
    const text = buildAskAnswerText(questions, answers);
    const chatId = pending.questionChatId ?? this.getAgentChatId(this.agents.get(agentId)!);
    if (chatId == null) {
      this.logger.warn({ agentId, reqId: pending.requestId }, 'AskUserQuestion answer has no chat to route to — dropping');
      return;
    }
    this.sendToCC(agentId, { text }, { chatId, spawnSource: 'telegram' });
  }

  /**
   * Cancel any pending AskUserQuestion for this chat by denying the permission
   * request and editing the keyboard message to show it was discarded.
   */
  private cancelPendingAskUserQuestions(agent: AgentInstance, chatId: number, proc: ICCProcess): void {
    for (const [reqId, pending] of agent.pendingPermissions) {
      if (pending.toolName !== 'AskUserQuestion') continue;
      if (pending.questionChatId !== chatId) continue;
      proc.respondToPermission(reqId, false);
      agent.pendingPermissions.delete(reqId);
      if (pending.questionMsgId && pending.questionChatId && agent.tgBot) {
        agent.tgBot.editText(pending.questionChatId, pending.questionMsgId, '❌ Question discarded — you wrote again.', 'HTML')
          .catch(err => this.logger.warn({ err, reqId }, 'Failed to mark discarded AskUserQuestion'));
      }
      this.logger.info({ agentId: agent.id, chatId, reqId }, 'Cancelled pending AskUserQuestion — user wrote again');
    }
  }

  // ── Process cleanup helper ──

  /**
   * Kill one chat's CC process and clean up its per-chat state.
   */
  private killChatProcess(agentId: string, chatId: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const cs = getChatSession(agent, chatId);
    if (!cs) return;

    const proc = cs.ccProcess;
    if (proc) {
      const entry = this.processRegistry.findByProcess(proc);
      if (entry) {
        this.processRegistry.destroy(entry.repo, entry.sessionId);
      } else {
        proc.destroy();
      }
    }
    cs.ccProcess = null;

    // Clean up accumulator & tracker
    if (cs.accumulator) {
      cs.accumulator.finalize();
      cs.accumulator = null;
    }
    if (cs.subAgentTracker) {
      cs.subAgentTracker.reset();
      cs.subAgentTracker = null;
    }
    this.stopTypingIndicator(agent, chatId);

    agent.chatSessions.delete(chatId);
  }

  /**
   * Kill ALL of an agent's CC processes (every chat) and clean up.
   */
  private killAgentProcess(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    // If agent has an active CLI session, kill via ctl socket
    if (this.ctlServer.hasCliSession(agentId)) {
      this.ctlServer.sendToCliSocket(agentId, { type: 'cli_kill' });
    }

    for (const chatId of [...agent.chatSessions.keys()]) {
      this.killChatProcess(agentId, chatId);
    }
  }

  // ── Typing indicator management ──

  /** Get the primary TG chat ID for an agent. Priority: typing > last message > first allowed user. */
  /** Get MCP tool capabilities for an agent. */
  private getAgentCapabilities(agentId: string): string[] {
    if (agentId === this.nativeSupervisorId) return ['*'];
    if (this.ralphManager.isRalph(agentId)) return ['observe', 'manage', 'watch:self', 'basic'];
    return [];
  }

  private getAgentChatId(agent: AgentInstance): number | null {
    // Last TG chat that sent a message
    if (agent.lastTgChatId) return agent.lastTgChatId;
    // Fall back to first allowed user (DM chatId == userId for private chats)
    const firstUser = agent.config.allowedUsers[0];
    return firstUser ? Number(firstUser) : null;
  }

  /** Resolve an agent's "primary" ChatSession for agent-level contexts (supervisor wakes,
   *  cron, heartbeat) where there is no originating chat. Uses getAgentChatId as the fallback. */
  private getPrimaryChatSession(agent: AgentInstance): ChatSession | undefined {
    const chatId = this.getAgentChatId(agent);
    if (chatId == null) return undefined;
    return getChatSession(agent, chatId);
  }

  /** True if the agent has no CC process actively mid-turn across any of its chats. */
  private agentIsIdle(agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return true;
    for (const cs of agent.chatSessions.values()) {
      const st = cs.ccProcess?.state;
      if (st && st !== 'idle') return false;
    }
    return true;
  }

  /** The CC session id of an agent's primary chat (for supervisor subscription checks).
   *  Falls back to any chat's active CC process if the primary chat has none. */
  private agentPrimarySessionId(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const primary = this.getPrimaryChatSession(agent);
    if (primary?.ccProcess?.sessionId) return primary.ccProcess.sessionId;
    for (const cs of agent.chatSessions.values()) {
      if (cs.ccProcess?.sessionId) return cs.ccProcess.sessionId;
    }
    return null;
  }

  private startTypingIndicator(agent: AgentInstance, chatId: number): void {
    const cs = getOrCreateChatSession(agent, chatId);
    // Don't create duplicate intervals
    if (cs.typingInterval) {
      this.logger.info({ agentId: agent.id, chatId }, 'startTypingIndicator: already running, skipping');
      return;
    }
    if (!agent.tgBot) return;
    this.logger.info({ agentId: agent.id, chatId }, 'startTypingIndicator: starting');
    // Send immediately, then repeat every 4s (TG typing badge lasts ~5s)
    agent.tgBot.sendTyping(chatId);
    const interval = setInterval(() => {
      agent.tgBot?.sendTyping(chatId);
    }, 4_000);
    cs.typingInterval = interval;
  }

  private stopTypingIndicator(agent: AgentInstance, chatId: number): void {
    const cs = getChatSession(agent, chatId);
    if (cs?.typingInterval) {
      this.logger.info({ agentId: agent.id, chatId }, 'stopTypingIndicator: stopping');
      clearInterval(cs.typingInterval);
      cs.typingInterval = null;
    } else {
      this.logger.info({ agentId: agent.id, chatId }, 'stopTypingIndicator: no interval (already stopped)');
    }
  }

  private spawnCCProcess(agentId: string, chatId: number): ICCProcess {
    const agent = this.agents.get(agentId)!;
    const agentState = this.sessionStore.getAgent(agentId);
    const cs = getOrCreateChatSession(agent, chatId);

    // Build userConfig from agent-level state
    const userConfig = resolveUserConfig(agent.config, agent.config.allowedUsers[0] || 'default');
    userConfig.repo = agent.repo;
    userConfig.model = agent.model;
    if (agentState.permissionMode) {
      userConfig.permissionMode = agentState.permissionMode as typeof userConfig.permissionMode;
    }

    // Determine session ID and whether to continue
    let sessionId = cs.pendingSessionId ?? undefined;
    cs.pendingSessionId = null; // consumed
    const forceNew = cs.forceNewSession;
    cs.forceNewSession = false; // consumed

    // Resume only via an explicit sessionId we own. Never use bare `--continue` — it picks
    // the newest JSONL in the project dir by mtime, which may be a `claude` CLI session or
    // another chat/agent sharing the repo. If we have no tracked sessionId for this chat,
    // start fresh instead.
    if (!sessionId && !forceNew) {
      sessionId = this.sessionStore.getSessionForChat(agentId, chatId);
    }
    if (sessionId) {
      const jsonlPath = getSessionJsonlPath(sessionId, this.agentSessionRepo(agent), agent.claudeConfigDir);
      // If state.json's sessionsByChat tracks this session for THIS agent/chat,
      // it's ours — skip the externally-active check entirely. The lock-based
      // check is a safety net for unknown sessions; for tracked ones it just
      // false-positives whenever we lost the lock (clean exit before the lock
      // was made persistent, etc.).
      const tracked = this.sessionStore.getSessionForChat(agentId, chatId);
      const knownOurs = tracked === sessionId;
      if (!existsSync(jsonlPath)) {
        // Tracked session's JSONL is gone (deleted, or never persisted) — start fresh.
        this.logger.info({ agentId, chatId, sessionId }, 'Tracked session JSONL missing — starting fresh');
        sessionId = undefined;
      } else if (!knownOurs && isSessionExternallyActive(sessionId, jsonlPath, agentId)) {
        // Unknown sessionId (came from pendingSessionId, not from our state) and
        // something else is actively writing the JSONL → assume an interactive
        // `claude` in a terminal owns it and start fresh instead of yanking.
        this.logger.info({ agentId, sessionId }, 'Session externally active — spawning fresh instead of resuming');
        if (agent.tgBot) {
          agent.tgBot.sendText(chatId, '<blockquote>📎 Detected active <code>claude</code> on this project — starting fresh session for TG.</blockquote>', 'HTML', true)
            .catch(err => this.logger.warn({ err }, 'Failed to send external-session notification'));
        }
        sessionId = undefined;
      }
    }
    const continueSession = !forceNew && !!sessionId;

    // Start MCP socket listener for this agent (bridge-side, receives tool calls from CC's MCP client)
    const mcpSocketPath = join(this.config.global.socketDir, `${agentId}-${agentId}.sock`);
    this.mcpServer.listen(mcpSocketPath);

    // Compute isolated CLAUDE_CONFIG_DIR for shared agents
    let claudeConfigDir: string | undefined;
    if (agent.config.share) {
      const slug = computeProjectSlug(agent.repo);
      claudeConfigDir = join(homedir(), '.tgcc', 'agents', agentId, 'repos', slug, '.claude');
      mkdirSync(claudeConfigDir, { recursive: true });
      agent.claudeConfigDir = claudeConfigDir;
    }

    const isDockerMode = agent.config.share?.mode === 'docker';

    // Generate container CLAUDE.md (combines repo's CLAUDE.md + container instructions)
    if (isDockerMode && claudeConfigDir) {
      generateContainerClaudeMd(userConfig.repo, claudeConfigDir, agent.config.share?.claude_md);
    }

    let mcpConfigPath: string;
    let proc: ICCProcess;

    if (isDockerMode && agent.config.share && claudeConfigDir) {
      // Docker mode: generate MCP config into the mounted .claude/ dir
      // so it's accessible inside the container at /home/project/.claude/
      mcpConfigPath = generateContainerMcpConfig(
        agentId,
        agentId,
        claudeConfigDir,
        undefined,
        chatId,
      );

      // Ensure the container is running (syncs auth, mounts repo + dist + sockets)
      const tgccDistDir = join(dirname(new URL(import.meta.url).pathname), '..');
      const relaySocketPath = ensureContainer({
        agentId,
        repo: userConfig.repo,
        shareConfig: agent.config.share,
        socketDir: this.config.global.socketDir,
        claudeConfigDir,
        tgccDistDir,
      });
      this.logger.info({ agentId, socketPath: relaySocketPath }, 'Docker container ensured');

      // Translate host MCP config path to container-local path
      const mcpConfigFilename = mcpConfigPath.split('/').pop()!;
      const containerMcpConfigPath = `/home/project/.claude/${mcpConfigFilename}`;

      proc = new ContainerCCProcess({
        agentId,
        userId: agentId,
        chatId,
        socketPath: relaySocketPath,
        userConfig,
        mcpConfigPath: containerMcpConfigPath,
        sessionId,
        continueSession,
        logger: this.logger,
        claudeConfigDir,
      });
    } else {
      // Local mode: generate MCP config with host paths
      const mcpServerPath = resolveMcpServerPath();
      mcpConfigPath = generateMcpConfig(
        agentId,
        agentId,
        this.config.global.socketDir,
        mcpServerPath,
        this.getAgentCapabilities(agentId),
        this.config.global.mcpConfigDir,
        chatId,
        agent.repo,
      );

      proc = new CCProcess({
        agentId,
        userId: agentId,
        chatId,
        ccBinaryPath: this.config.global.ccBinaryPath,
        userConfig,
        mcpConfigPath,
        sessionId,
        continueSession,
        logger: this.logger,
        claudeConfigDir,
      });
    }

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
      this.sessionStore.setSessionForChat(agentId, chatId, event.session_id);
      agent.eventBuffer.push({ ts: Date.now(), type: 'system', text: `Session initialized: ${event.session_id}` });

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
      this.highSignalDetector.handleStreamEvent(agentId, event);
      this.handleStreamEvent(agentId, chatId, event);
    });

    proc.on('tool_result', (event: ToolResultEvent) => {
      // Conversation monitor: mirror the tool result (redacted, truncated). Buffered until the
      // next assistant flush or turn end — see monitor.ts recordToolResult.
      this.monitor.recordToolResult(agentId, chatId, event);

      // Log to event buffer
      const toolName = event.tool_use_result?.name ?? 'unknown';
      const isToolErr = event.is_error === true;
      const toolContent = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
      const toolSummary = toolContent.length > 200 ? toolContent.slice(0, 200) + '…' : toolContent;
      agent.eventBuffer.push({ ts: Date.now(), type: 'tool', text: `${isToolErr ? '❌' : '✅'} ${toolName}: ${toolSummary}` });

      // High-signal detection
      this.highSignalDetector.handleToolResult(agentId, event.tool_use_id, toolContent, isToolErr, toolName !== 'unknown' ? toolName : undefined);

      // Resolve tool indicator message with success/failure status
      const acc = cs.accumulator;
      if (acc && event.tool_use_id) {
        const isError = event.is_error === true;
        const contentStr = typeof event.content === 'string' ? event.content : JSON.stringify(event.content);
        const errorMsg = isError ? contentStr : undefined;
        acc.resolveToolMessage(event.tool_use_id, isError, errorMsg, contentStr, event.tool_use_result);
      }

      const tracker = cs.subAgentTracker;
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
                wrapSystemReminder('All background agents have reported back. Please read their results from the mailbox/files and provide a synthesis to the user.'),
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
      if (cs.subAgentTracker) {
        cs.subAgentTracker.handleTaskStarted(event.tool_use_id, event.description, event.task_type);
      }
      // Update the in-turn sub-agent segment in the main bubble
      if (cs.accumulator && event.tool_use_id) {
        cs.accumulator.updateSubAgentSegment(event.tool_use_id, 'dispatched', event.description);
      }
    });

    proc.on('task_progress', (event: TaskProgressEvent) => {
      if (cs.subAgentTracker) {
        cs.subAgentTracker.handleTaskProgress(event.tool_use_id, event.description, event.last_tool_name);
      }
      // Update the in-turn sub-agent segment in the main bubble with progress
      if (cs.accumulator && event.tool_use_id) {
        cs.accumulator.appendSubAgentProgress(event.tool_use_id, event.description, event.last_tool_name);
      }
    });

    proc.on('task_completed', (event: TaskCompletedEvent) => {
      if (cs.subAgentTracker) {
        cs.subAgentTracker.handleTaskCompleted(event.tool_use_id);
      }
      // Update the in-turn sub-agent segment in the main bubble
      if (cs.accumulator && event.tool_use_id) {
        cs.accumulator.updateSubAgentSegment(event.tool_use_id, 'completed');
      }
    });

    // Media from tool results (images, PDFs, etc.)
    proc.on('media', async (media: { kind: string; media_type: string; data: string }) => {
      const buf = Buffer.from(media.data, 'base64');
      if (!agent.tgBot) return;

      // Seal the current bubble so subsequent text starts a new one below the media
      if (cs.accumulator) cs.accumulator.reset();

      try {
        if (media.kind === 'image') {
          await agent.tgBot.sendPhotoBuffer(chatId, buf);
        } else if (media.kind === 'document') {
          await agent.tgBot.sendDocumentBuffer(chatId, buf, `document${media.media_type === 'application/pdf' ? '.pdf' : ''}`);
        }
      } catch (err) {
        this.logger.error({ err, agentId }, 'Failed to send tool_result media');
      }
    });

    proc.on('assistant', (event: AssistantMessage) => {
      // Conversation monitor: mirror thinking/text/tool_use blocks from this complete assistant
      // message (one flush per message_stop — see monitor.ts recordAssistant for why this also
      // satisfies "destructive tool calls flush immediately").
      this.monitor.recordAssistant(agentId, chatId, event);

      // Log text and thinking blocks to event buffer
      if (event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === 'thinking' && block.thinking) {
            const truncated = block.thinking.length > 300 ? block.thinking.slice(0, 300) + '…' : block.thinking;
            agent.eventBuffer.push({ ts: Date.now(), type: 'thinking', text: truncated });
          } else if (block.type === 'text' && block.text) {
            agent.eventBuffer.push({ ts: Date.now(), type: 'text', text: block.text });
          } else if (block.type === 'tool_use') {
            const toolBlock = block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
            this.highSignalDetector.handleAssistantToolUse(agentId, toolBlock.name, toolBlock.id, toolBlock.input);

            // AskUserQuestion and ExitPlanMode are handled via can_use_tool control_request
            // (--permission-prompt-tool stdio), not here in the tool_use block.
          }
        }
      }
    });

    proc.on('result', (event: ResultEvent) => {
      // Conversation monitor: flush any remaining buffered lines (e.g. a trailing tool_result
      // with no following assistant text) and tag the turn's end.
      this.monitor.recordTurnEnd(agentId, chatId, event);

      this.stopTypingIndicator(agent, chatId);
      this.highSignalDetector.handleTurnEnd(agentId);
      // Track cumulative session cost and check budget thresholds
      if (event.total_cost_usd != null) {
        this.highSignalDetector.handleCostUpdate(agentId, event.total_cost_usd);
      }
      agent.eventBuffer.push({ ts: Date.now(), type: 'system', text: `Turn complete${event.is_error ? ' (error)' : ''}${event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : ''}` });
      void this.handleResult(agentId, chatId, event);

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
      agent.eventBuffer.push({ ts: Date.now(), type: 'system', text: label + tokenInfo });
      if (agent.tgBot) {
        // Finalize the current streaming bubble so the compact notice appears below it
        const acc = cs.accumulator;
        const flush = acc?.hasActiveBubble ? acc.flushIfDirty().then(() => acc.reset()) : Promise.resolve();
        flush
          .then(() => agent.tgBot!.sendText(
            chatId,
            `<blockquote>${escapeHtml(label + tokenInfo)}</blockquote>`,
            'HTML',
            true, // silent
          ))
          .catch((err: Error) => this.logger.error({ err }, 'Failed to send compact notification'));
      }
    });

    proc.on('permission_request', (event: PermissionRequest) => {
      const req = event.request;
      const requestId = event.request_id;

      const pending: PendingPermission = {
        requestId,
        userId: agentId,
        toolName: req.tool_name,
        input: req.input,
      };
      agent.pendingPermissions.set(requestId, pending);

      const permChatId = chatId;

      if (req.tool_name === 'AskUserQuestion' && permChatId && agent.tgBot) {
        // Show interactive question UI instead of generic Allow/Deny
        // Flush current bubble first so the question appears after the assistant text
        const flushAndSend = async () => {
          if (cs.accumulator) {
            await cs.accumulator.flushIfDirty();
            cs.accumulator.reset();
          }
          const questions = (req.input?.questions ?? []) as AskQuestion[];
          pending.questionAnswers = {};
          const { text, keyboard } = buildAskUi(requestId, questions, {});
          const msgId = await agent.tgBot!.sendTextWithKeyboard(permChatId, text, keyboard, 'HTML');
          pending.questionMsgId = msgId;
          pending.questionChatId = permChatId;
        };
        flushAndSend().catch(err => this.logger.error({ err }, 'Failed to send AskUserQuestion UI'));
      } else if (req.tool_name === 'ExitPlanMode' && permChatId && agent.tgBot) {
        // Show plan approval UI — flush current bubble first so it appears in correct order
        const flushAndSendPlan = async () => {
          if (cs.accumulator) {
            await cs.accumulator.flushIfDirty();
            cs.accumulator.reset();
          }
          // Send plan content as a .md document if available
          const planContent = req.input?.plan as string | undefined;
          const planFilePath = req.input?.planFilePath as string | undefined;
          if (planContent && agent.tgBot) {
            const filename = planFilePath ? planFilePath.split('/').pop()! : 'plan.md';
            await agent.tgBot.sendDocumentBuffer(
              permChatId,
              Buffer.from(planContent, 'utf-8'),
              filename,
            );
          }
          const planText = '📋 Plan submitted — approve to start implementing.';
          const keyboard = new InlineKeyboard()
            .text('✅ Approve', `perm_allow:${requestId}`)
            .text('❌ Reject', `perm_deny:${requestId}`);
          await agent.tgBot!.sendTextWithKeyboard(permChatId, planText, keyboard, 'HTML');
        };
        flushAndSendPlan().catch(err => this.logger.error({ err }, 'Failed to send ExitPlanMode UI'));
      } else if (permChatId && agent.tgBot) {
        // Generic permission prompt
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
        agent.tgBot.sendTextWithKeyboard(permChatId, text, keyboard, 'HTML')
          .catch(err => this.logger.error({ err }, 'Failed to send permission request'));
      }

      // Forward to supervisor so it can render approve/deny UI
      if (this.isSupervisorSubscribed(agentId, proc.sessionId)) {
        const description = req.decision_reason || `CC wants to use ${req.tool_name}`;
        const supervisorEvent: Record<string, unknown> = {
          type: 'event',
          event: 'permission_request',
          agentId,
          toolName: req.tool_name,
          requestId,
          description,
        };
        if (req.tool_name === 'ExitPlanMode' && req.input?.plan) {
          supervisorEvent.planContent = req.input.plan;
        }
        this.sendToSupervisor(supervisorEvent);
      }
    });

    proc.on('api_error', (event: ApiErrorEvent) => {
      const errMsg = event.error?.message || 'Unknown API error';
      const status = event.error?.status;
      const isOverloaded = status === 529 || errMsg.includes('overloaded');
      const retryInfo = event.retryAttempt != null && event.maxRetries != null
        ? ` (retry ${event.retryAttempt}/${event.maxRetries})`
        : '';

      agent.eventBuffer.push({ ts: Date.now(), type: 'error', text: `${errMsg}${retryInfo}` });

      // Auth error detection — trigger OAuth fallback via Telegram
      if (isAuthError(status, errMsg) && !agent.authFlowInProgress) {
        this.triggerAuthFallback(agentId);
        return; // skip normal error display — auth flow handles messaging
      }

      const text = isOverloaded
        ? formatSystemMessage('error', `API overloaded, retrying...${retryInfo}`)
        : formatSystemMessage('error', `${escapeHtml(errMsg)}${retryInfo}`);

      if (agent.tgBot) {
        agent.tgBot.sendText(chatId, text, 'HTML', true) // silent
          .catch(err => this.logger.error({ err }, 'Failed to send API error notification'));
      }
    });

    proc.on('idle', () => {
      cs.pendingSessionId = proc.sessionId ?? null;
      this.stopTypingIndicator(agent, chatId);
      // Auto-destroy ephemeral agents when their CC session ends naturally
      // Skip ralph/watcher agents — they stay alive waiting for events and have their own timeout
      if (agent.ephemeral && !this.ralphManager.isRalph(agentId)) {
        this.logger.info({ agentId }, 'Ephemeral agent session idle — auto-destroying');
        this.destroyEphemeralAgent(agentId);
      }
    });

    proc.on('hang', () => {
      cs.pendingSessionId = proc.sessionId ?? null;
      this.stopTypingIndicator(agent, chatId);
      if (agent.tgBot) {
        agent.tgBot.sendText(chatId, '<blockquote>⚠️ Session killed — Claude was unresponsive. Send a message to resume.</blockquote>', 'HTML', true)
          .catch(err => this.logger.error({ err }, 'Failed to send hang notification'));
      }
    });

    proc.on('takeover', () => {
      this.logger.warn({ agentId }, 'Session takeover detected — keeping session for roaming');
      agent.eventBuffer.push({ ts: Date.now(), type: 'system', text: 'Session takeover detected' });

      // NOTE: No TG message sent for takeover — too noisy on restart races.
      // Takeover is logged (above) and forwarded to supervisor; user will notice naturally
      // when their next message starts a new session.

      // Notify supervisor and suppress subsequent exit event
      if (this.isSupervisorSubscribed(agentId, proc.sessionId)) {
        this.sendToSupervisor({ type: 'event', event: 'session_takeover', agentId, sessionId: proc.sessionId });
        this.suppressExitForProcess.add(proc.sessionId ?? '');
      }

      this.stopTypingIndicator(agent, chatId);
      const entry = getEntry();
      if (entry) {
        this.processRegistry.remove(entry.repo, entry.sessionId);
      }
      if (cs.ccProcess === proc) cs.ccProcess = null;
      proc.destroy();
    });

    proc.on('exit', () => {
      const wasActive = proc.stateBeforeExit === 'active' && proc.activityBeforeExit !== 'idle';
      const wasKilledByUs = proc.killedBeforeExit;
      agent.eventBuffer.push({ ts: Date.now(), type: 'system', text: wasActive ? 'Process died mid-turn' : 'Process exited' });
      this.highSignalDetector.cleanup(agentId);
      this.eventDedup.cleanup(agentId);

      // If the supervisor's session just ended, clear tracked workers and stop heartbeat
      if (agentId === this.nativeSupervisorId) {
        this.supervisorManager?.clearTracked();
        this.stopHeartbeat();
      }

      // Notify TG about process exit (skip ephemeral agents and user-initiated kills like /new)
      if (agent.tgBot && !agent.ephemeral && !wasKilledByUs) {
        const msg = wasActive
          ? 'Session ended unexpectedly (process exited mid-turn). Next message starts a new session.'
          : 'Session ended. Next message starts a new session — use /sessions to resume a previous one.';
        const msgType = wasActive ? 'error' : 'status';
        agent.tgBot.sendText(chatId, formatSystemMessage(msgType, msg), 'HTML', true)
          .catch(err => this.logger.error({ err }, 'Failed to send process exit notification'));
      }

      // Forward to supervisor (unless suppressed by takeover)
      if (this.suppressExitForProcess.has(proc.sessionId ?? '')) {
        this.suppressExitForProcess.delete(proc.sessionId ?? '');
      } else {
        if (this.isSupervisorSubscribed(agentId, proc.sessionId)) {
          this.sendToSupervisor({ type: 'event', event: 'process_exit', agentId, sessionId: proc.sessionId, exitCode: null });
        }
        // Native supervisor: notify if worker is tracked
        if (this.supervisorManager?.isTracked(agentId)) {
          this.pushSupervisorEvent(agentId, wasActive ? `💀 Process died mid-turn` : `💀 Process exited`);
        }
        // Route to EventRouter → watchers (ralph) + future consumers
        this.eventRouter.routeLifecycle({
          type: 'process_exited', agentId, event: 'process_exited',
          summary: wasActive ? 'Process died mid-turn' : 'Process exited',
        });
      }

      this.stopTypingIndicator(agent, chatId);

      if (cs.accumulator) {
        cs.accumulator.finalize();
        cs.accumulator = null;
      }
      if (cs.subAgentTracker) {
        cs.subAgentTracker.stopMailboxWatch();
        cs.subAgentTracker = null;
      }

      const entry = getEntry();
      if (entry) {
        this.processRegistry.remove(entry.repo, entry.sessionId);
      }
      if (cs.ccProcess === proc) cs.ccProcess = null;
      // Process exited — next message should start a fresh session
      cs.forceNewSession = true;
      // Auto-destroy ephemeral agents on process exit
      // Skip ralph/watcher agents — they stay alive waiting for events and have their own timeout
      if (agent.ephemeral && !this.ralphManager.isRalph(agentId)) {
        this.logger.info({ agentId }, 'Ephemeral agent process exited — auto-destroying');
        this.destroyEphemeralAgent(agentId);
      }
    });

    proc.on('error', (err: Error) => {
      agent.eventBuffer.push({ ts: Date.now(), type: 'error', text: err.message });
      this.stopTypingIndicator(agent, chatId);
      if (agent.tgBot) {
        agent.tgBot.sendText(chatId, formatSystemMessage('error', escapeHtml(String(err.message))), 'HTML', true) // silent
          .catch(err2 => this.logger.error({ err: err2 }, 'Failed to send process error notification'));
      }
    });

    return proc;
  }

  // ── Stream event handling ──

  private handleStreamEvent(agentId: string, chatId: number, event: StreamInnerEvent): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const cs = getOrCreateChatSession(agent, chatId);

    if (!cs.accumulator && agent.tgBot) {
      const tgBot = agent.tgBot; // capture for closures (non-null here)
      const sender: TelegramSender = {
        sendMessage: (cid, text, parseMode) => {
          this.logger.info({ agentId, chatId: cid, textLen: text.length }, 'TG accumulator sendMessage');
          return tgBot.sendText(cid, text, parseMode, true); // silent — no push notification
        },
        editMessage: (cid, msgId, text, parseMode) => {
          this.logger.info({ agentId, chatId: cid, msgId, textLen: text.length }, 'TG accumulator editMessage');
          return tgBot.editText(cid, msgId, text, parseMode);
        },
        deleteMessage: (cid, msgId) => tgBot.deleteMessage(cid, msgId),
        setReaction: (cid, msgId, emoji) => tgBot.setReaction(cid, msgId, emoji),
        sendPhoto: (cid, buffer, caption) => tgBot.sendPhotoBuffer(cid, buffer, caption),
      };
      const onError = (err: unknown, context: string) => {
        this.logger.error({ err, context, agentId }, 'Stream accumulator error');
        tgBot.sendText(chatId, formatSystemMessage('error', escapeHtml(context)), 'HTML', true).catch(() => {}); // silent
      };
      cs.accumulator = new StreamAccumulator({ chatId, sender, logger: this.logger, onError });
    }

    if (!cs.subAgentTracker && agent.tgBot) {
      const tgBot = agent.tgBot; // capture for closures (non-null here)
      const subAgentSender: SubAgentSender = {
        sendMessage: (cid, text, parseMode) =>
          tgBot.sendText(cid, text, parseMode, true), // silent
        editMessage: (cid, msgId, text, parseMode) =>
          tgBot.editText(cid, msgId, text, parseMode),
        setReaction: (cid, msgId, emoji) =>
          tgBot.setReaction(cid, msgId, emoji),
      };
      cs.subAgentTracker = new SubAgentTracker({
        chatId,
        sender: subAgentSender,
        onEditAttempt: (msgId, preview) => cs.accumulator?.logIfSealed(msgId, preview),
        onAllDone: ({ count, elapsedMs }) => {
          const elapsed = elapsedMs > 0 ? `${Math.round(elapsedMs / 1000)}s` : '';
          this.highSignalDetector.emitEvent(agentId, {
            type: 'event',
            event: 'subagent_all_done',
            agentId,
            count,
            elapsed,
          });
        },
      });
    }

    // On message_start: only start a new bubble if the previous turn was sealed
    // (i.e. a result event finalized it). CC sends message_start on every tool-use
    // loop within the same turn — those must reuse the same bubble via softReset.
    if (event.type === 'message_start') {
      if (cs.accumulator?.sealed) {
        // Previous turn is done (result event sealed it) → new bubble
        agent.awaitingAskCleanup = false;
        cs.accumulator.reset();
        if (cs.subAgentTracker && !cs.subAgentTracker.hasDispatchedAgents) {
          cs.subAgentTracker.reset();
        }
      } else if (cs.accumulator) {
        // Mid-turn tool-use loop → keep same bubble, clear transient state
        cs.accumulator.softReset();
      }
      // Ensure typing indicator is running whenever CC starts a new message — covers the
      // gap created by a steer (result event for the abandoned turn stopped typing before
      // events for the new turn arrive).
      this.startTypingIndicator(agent, chatId);
    }

    cs.accumulator?.handleEvent(event).catch(err => {
      this.logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err, agentId }, 'Stream accumulator handleEvent error');
    });
    cs.subAgentTracker?.handleEvent(event).catch(err => {
      this.logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err, agentId }, 'Sub-agent tracker handleEvent error');
    });
  }

  /**
   * Trigger the OAuth auth fallback flow for an agent.
   * Kills the current CC process, runs `claude auth login` via TG, then retries.
   */
  private async triggerAuthFallback(agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent || agent.authFlowInProgress) return;
    if (!this.config.global.authFallbackEnabled) return;

    const chatId = this.getAgentChatId(agent);
    if (!chatId || !agent.tgBot) {
      this.logger.warn({ agentId }, 'Auth fallback skipped — no TG chat');
      return;
    }

    agent.authFlowInProgress = true;

    // Kill all CC processes for this agent (auth error is account-wide, not chat-specific)
    this.killAgentProcess(agentId);

    this.logger.info({ agentId }, 'Auth error detected — starting OAuth fallback flow');
    agent.eventBuffer.push({ ts: Date.now(), type: 'system', text: '🔑 Auth error detected — starting OAuth fallback' });

    const result = await runAuthFlow({
      ccBinaryPath: this.config.global.ccBinaryPath,
      chatId,
      tgBot: agent.tgBot,
      timeoutMs: this.config.global.authFallbackTimeoutMs,
      logger: this.logger,
    });

    agent.authFlowInProgress = false;

    if (result.success && agent.lastSendData) {
      // Retry the last message
      const { text, source } = agent.lastSendData;
      agent.lastSendData = null;
      // Pin a fresh session for the retry chat (auth error invalidated the old process)
      const retryChatId = source?.chatId ?? this.getAgentChatId(agent);
      if (retryChatId != null) {
        getOrCreateChatSession(agent, retryChatId).forceNewSession = true;
      }
      this.logger.info({ agentId }, 'Auth successful — retrying last message');
      await this.sendToCC(agentId, { text }, source);
    } else if (!result.success) {
      agent.lastSendData = null;
      this.logger.error({ agentId, error: result.error }, 'Auth fallback failed');
    }
  }

  private async handleResult(agentId: string, chatId: number, event: ResultEvent): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    const cs = getOrCreateChatSession(agent, chatId);

    // waitForResult: resolve the pending promise and auto-destroy
    const pendingWait = this.pendingWaitForResult.get(agentId);
    if (pendingWait) {
      this.pendingWaitForResult.delete(agentId);
      clearTimeout(pendingWait.timer);
      const resultText = typeof event.result === 'string' ? event.result : null;
      pendingWait.resolve({
        id: '',
        success: !event.is_error,
        result: { agentId, result: resultText },
        ...(event.is_error ? { error: resultText || 'Agent returned an error' } : {}),
      });
      this.destroyEphemeralAgent(agentId);
      return;
    }

    // Always reset mute on turn complete — mute is disabled for now, but keep the reset
    // so any stale value cleared from a pre-upgrade state doesn't persist.
    agent.muteOutput = false;

    // Set usage stats on the accumulator before finalizing
    const acc = cs.accumulator;
    if (acc) {
      if (event.usage) {
        const proc = cs.ccProcess;
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
      await acc.finalize();

      // Clean up the fallback bubble CC generates after an AskUserQuestion rejection.
      // The keyboard message is the real UI; the accumulator bubble is redundant noise.
      if (agent.awaitingAskCleanup && agent.tgBot) {
        agent.awaitingAskCleanup = false;
        const bubbleId = acc.lastBubbleId;
        if (bubbleId) {
          agent.tgBot.deleteMessage(chatId, bubbleId)
            .catch(err => this.logger.warn({ err, bubbleId }, 'Failed to delete AskUserQuestion fallback bubble'));
        }
      }
    }

    // Clear stale ExitPlanMode keyboards — CC may have auto-resolved the tool_use before the
    // user clicked. If the button fires after the turn ends, sendToolResult creates a duplicate.
    for (const [id, pending] of agent.pendingPermissions) {
      if (pending.toolName === 'ExitPlanMode') {
        agent.pendingPermissions.delete(id);
      }
    }

    // Route turn-complete to native supervisor (routine — errors escalate via result error path)
    const cost = event.total_cost_usd ? ` · $${event.total_cost_usd.toFixed(4)}` : '';
    const sessionTag = this.formatSessionTag(agent, cs.ccProcess?.sessionId);
    this.pushSupervisorEvent(agentId, `${event.is_error ? '❌' : '✅'} Turn complete${cost}${sessionTag}`, false, false, 'routine');

    // Route to EventRouter → watchers (ralph) + future consumers
    this.eventRouter.routeLifecycle({
      type: 'turn_complete', agentId, event: 'turn_complete',
      cost: event.total_cost_usd ? `$${event.total_cost_usd.toFixed(4)}` : undefined,
      isError: event.is_error,
      replySnippet: typeof event.result === 'string' ? event.result.trim().slice(0, 300) : undefined,
    });

    // Handle errors (only send to TG if bot available)
    if (event.is_error && agent.tgBot) {
      // Check if result errors contain auth failures — trigger auth fallback instead of showing error
      if (resultHasAuthError(event.errors) && !agent.authFlowInProgress) {
        void this.triggerAuthFallback(agentId);
        return;
      }

      // Capture diagnostic errors from error_during_execution subtype
      const errorDetails = event.errors?.length
        ? event.errors.join('\n')
        : String(event.result || 'Unknown error');
      agent.tgBot!.sendText(chatId, formatSystemMessage('error', escapeHtml(errorDetails)), 'HTML', true) // silent
        .catch(err => this.logger.error({ err }, 'Failed to send result error notification'));
    }

    // If background sub-agents are still running, mailbox watcher handles them.
    const tracker = cs.subAgentTracker;
    if (tracker?.hasDispatchedAgents && tracker.currentTeamName) {
      this.logger.info({ agentId }, 'Turn ended with background sub-agents still running');
      const ccProcess = cs.ccProcess;
      if (ccProcess) ccProcess.clearIdleTimer();
      // Create standalone post-turn status bubble (main bubble is now sealed)
      tracker.startPostTurnTracking().catch(err => this.logger.error({ err, agentId }, 'Failed to start post-turn tracking'));
      // Start mailbox watcher (works for general-purpose agents that have SendMessage)
      tracker.startMailboxWatch();
      // Fallback: send ONE follow-up after 60s if mailbox hasn't resolved all agents
      // This handles bash-type agents that can't write to mailbox
      if (!tracker.hasPendingFollowUp) {
        tracker.hasPendingFollowUp = true;
        setTimeout(() => {
          if (!tracker.hasDispatchedAgents) return;
          const proc = cs.ccProcess;
          if (!proc) return;
          this.logger.info({ agentId }, 'Mailbox timeout — sending single follow-up for remaining agents');
          for (const info of tracker.activeAgents) {
            if (info.status === 'dispatched') {
              tracker.markCompleted(info.toolUseId, '(results delivered in CC response)');
            }
          }
          proc.sendMessage(createTextMessage(wrapSystemReminder('The background agents should be done by now. Please read their results from the mailbox/files and report to the user.')));
        }, 60_000);
      }
    }
  }

  // ── Slash commands ──

  /**
   * True only for a GROUP/supergroup monitor destination, and only on the supervisor's own bot.
   *
   * Telegram private-chat ids equal the user's id and are IDENTICAL across every bot — so if
   * the destination were ever a DM (e.g. the owner's own, `7016073156`) and this matched on
   * chatId alone, EVERY agent's bot would see the owner's private chatId collide with
   * monitor.chatId and silently drop every message/command the owner sends to every agent. A
   * private-chat destination must instead work with no exclusion at all: mirrored messages land
   * in that DM alongside the owner's normal conversation with whichever bot posts there, and the
   * owner's conversations with every other agent continue unaffected. Group/supergroup chat ids
   * are Telegram-wide unique (never collide with a user id or another chat), so restricting to
   * chatId < 0 is sufficient by itself; the agentId check is defence in depth in case some other
   * agent's bot is also ever a member of that same group for an unrelated reason.
   */
  private isMonitorDestinationChat(agentId: string, chatId: number): boolean {
    if (chatId >= 0) return false; // never a private chat — see above
    if (agentId !== this.nativeSupervisorId) return false; // only the bot actually sitting in the monitor group
    return this.config.monitor?.chatId === chatId;
  }

  private async handleSlashCommand(agentId: string, cmd: SlashCommand): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (!agent.tgBot) return; // ephemeral agents don't have TG bots

    // Same one-way-feed rule as handleTelegramMessage, applied to commands: only monitor_here
    // (to move the destination) and a read-only status peek make sense inside the monitor
    // destination chat — everything else (/new, /repo, /model, ...) would act on whichever
    // agent's bot happens to be posting there, which is never what's intended.
    if (this.isMonitorDestinationChat(agentId, cmd.chatId) && cmd.command !== 'monitor_here' && cmd.command !== 'status') {
      return;
    }

    this.logger.debug({ agentId, command: cmd.command, args: cmd.args }, 'Slash command');

    // Per-chat session state for the chat this command came from.
    const cs = getOrCreateChatSession(agent, cmd.chatId);

    switch (cmd.command) {
      case 'start': {
        const repo = agent.repo;
        const model = agent.model;
        const session = cs.ccProcess?.sessionId;
        const lines = ['👋 <b>TGCC</b> — Telegram ↔ Claude Code bridge'];
        if (repo) lines.push(`📂 <code>${escapeHtml(shortenRepoPath(repo))}</code>`);
        if (model) lines.push(`🤖 ${escapeHtml(model)}`);
        if (session) lines.push(`📎 Session: <code>${escapeHtml(session.slice(0, 8))}</code>`);
        lines.push('', 'Send a message to start, or use /help for commands.');
        await agent.tgBot.sendText(cmd.chatId, lines.join('\n'), 'HTML');
        // Re-register commands with BotFather to ensure menu is up to date
        await agent.tgBot.refreshCommands().catch(() => {});
        break;
      }

      case 'help':
        await agent.tgBot.sendText(cmd.chatId, HELP_TEXT, 'HTML');
        break;

      case 'ping': {
        const state = cs.ccProcess?.state ?? 'idle';
        await agent.tgBot.sendText(cmd.chatId, `pong — process: <b>${state.toUpperCase()}</b>`, 'HTML');
        break;
      }

      case 'monitor_here': {
        // Defense in depth: TelegramBot only wires this command up on the supervisor's bot at
        // all (isSupervisorBot), but this handler is shared code reached from every bot, so it
        // re-checks independently via a pure, unit-testable function rather than trusting that
        // routing alone. The people this feature exists to watch (e.g. colleagues in
        // sentinella's allowedUsers) must never be able to move or disable the monitor
        // destination via some other agent's bot.
        const auth = checkMonitorHereAuth(agentId, this.nativeSupervisorId, cmd.userId, this.config.monitor?.ownerUserId);
        if (!auth.ok) {
          if (auth.reason === 'not-supervisor-bot') {
            this.logger.warn({ agentId, userId: cmd.userId }, '/monitor_here rejected — not the supervisor bot');
            break;
          }
          if (auth.reason === 'owner-not-configured') {
            await agent.tgBot.sendText(
              cmd.chatId,
              '<blockquote>⚠️ "monitor.ownerUserId" is not set in ~/.tgcc/config.json. Add a <code>monitor</code> block with at least <code>ownerUserId</code> (your Telegram user id) before /monitor_here can be used.</blockquote>',
              'HTML',
            );
            break;
          }
          // not-owner
          this.logger.warn({ agentId, userId: cmd.userId, ownerUserId: this.config.monitor?.ownerUserId }, '/monitor_here rejected — caller is not the configured owner');
          await agent.tgBot.sendText(cmd.chatId, "<blockquote>You're not authorized to change the conversation monitor destination.</blockquote>", 'HTML');
          break;
        }

        // Run inside the intended monitor destination chat (typically a private supergroup with
        // Topics enabled, with this bot added as admin) — records its chat id into
        // ~/.tgcc/config.json so the owner never has to look up a chat id by hand. Notifies the
        // previous destination (if any) so a destination change is never silent.
        this.monitor.registerHere(cmd.chatId, cmd.userId);
        await agent.tgBot.sendText(
          cmd.chatId,
          `<blockquote>✅ This chat (<code>${escapeHtml(String(cmd.chatId))}</code>) is now the conversation monitor destination.\nSet <code>monitor.agents</code> in ~/.tgcc/config.json to the agent IDs you want mirrored (or add them now if this is the first time).</blockquote>`,
          'HTML',
        );
        break;
      }

      case 'status': {
        const proc = cs.ccProcess;
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
        await agent.tgBot.sendText(cmd.chatId, `<b>Session cost:</b> $${(cs.ccProcess?.totalCostUsd ?? 0).toFixed(4)}`, 'HTML');
        break;
      }

      case 'new': {
        this.killChatProcess(agentId, cmd.chatId);
        this.sessionStore.clearSessionForChat(agentId, cmd.chatId);
        // killChatProcess deleted the ChatSession — recreate it and pin a fresh session.
        getOrCreateChatSession(agent, cmd.chatId).forceNewSession = true;
        const newPrompt = cmd.args?.trim();
        if (newPrompt) {
          // Immediately send the prompt — spawns a fresh session
          this.sendToCC(agentId, { text: newPrompt });
          const newLines = ['Session cleared. Sending prompt...'];
          if (agent.repo) newLines.push(`📂 <code>${escapeHtml(shortenRepoPath(agent.repo))}</code>`);
          if (agent.model) newLines.push(`🤖 ${escapeHtml(agent.model)}`);
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>${newLines.join('\n')}</blockquote>`, 'HTML');
        } else {
          const newLines = ['Session cleared. Next message starts fresh.'];
          if (agent.repo) newLines.push(`📂 <code>${escapeHtml(shortenRepoPath(agent.repo))}</code>`);
          if (agent.model) newLines.push(`🤖 ${escapeHtml(agent.model)}`);
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>${newLines.join('\n')}</blockquote>`, 'HTML');
        }
        break;
      }

      case 'new-cli':
      case 'new_cli': {
        // Spawn a CLI session via tmux
        if (!this.config.global.tmux) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>tmux not enabled. Set <code>"tmux": true</code> in global config.</blockquote>', 'HTML');
          break;
        }

        // Check if tmux is available
        let tmuxAvailable = false;
        try {
          execSync('which tmux', { stdio: 'ignore' });
          tmuxAvailable = true;
        } catch {}

        if (!tmuxAvailable) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>tmux not found on this system.</blockquote>', 'HTML');
          break;
        }

        // List existing tmux sessions
        let tmuxSessions: string[] = [];
        try {
          const out = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null", { encoding: 'utf-8' });
          tmuxSessions = out.trim().split('\n').filter(Boolean);
        } catch {
          // No tmux server running — that's fine, we'll create a new session
        }

        // Build inline keyboard with existing sessions + "New session" option
        const kb = new InlineKeyboard();
        for (const sess of tmuxSessions) {
          kb.text(sess, `cli-tmux:${agentId}:${sess}`).row();
        }
        kb.text('+ New session...', `cli-tmux-new:${agentId}`);

        await agent.tgBot.sendTextWithKeyboard(
          cmd.chatId,
          '<b>Select tmux session for CLI window:</b>',
          kb,
          'HTML',
        );
        break;
      }

      case 'newcc': {
        // /newcc [-w] <name> — then prompts: worktree yes/no (skipped when -w), repo.
        const extTokens = (cmd.args ?? '').trim().split(/\s+/).filter(Boolean);
        const extWorktreeFlag = extTokens.includes('-w');
        const extName = sanitizeSessionName(extTokens.filter((t) => t !== '-w').join(' '));
        if (!extName) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /newcc &lt;name&gt;\nThen pick worktree yes/no and a repo.</blockquote>', 'HTML');
          break;
        }
        if (Object.keys(this.config.repos).length === 0) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No repos configured. Use /repo add &lt;name&gt; &lt;path&gt; first.</blockquote>', 'HTML');
          break;
        }
        this.pendingExtCcNew.set(`${agentId}:${cmd.chatId}`, { name: extName, ...(extWorktreeFlag ? { worktree: true } : {}) });
        if (extWorktreeFlag) {
          await this.sendExtCcRepoKeyboard(agent, cmd.chatId, extName, true);
        } else {
          const extKb = new InlineKeyboard()
            .text('🌿 Yes — worktree', 'extcc-w:y')
            .text('No — repo checkout', 'extcc-w:n');
          await agent.tgBot.sendTextWithKeyboard(cmd.chatId, `<b>${escapeHtml(extName)}</b> — create in a git worktree?`, extKb, 'HTML');
        }
        break;
      }

      case 'listcc': {
        const extRemoved = this.externalCc.cleanup();
        const extSessions = this.externalCc.list();
        const extLines: string[] = [];
        if (extSessions.length === 0) {
          extLines.push('No external CC sessions. Use /newcc to create one.');
        } else {
          extLines.push(`<b>External CC sessions (${extSessions.length})</b>`);
          for (const s of extSessions) {
            extLines.push(`• <b>${escapeHtml(s.name)}</b>${s.worktree ? ' 🌿' : ''} — <code>${escapeHtml(s.repoName)}</code> · tmux <code>${escapeHtml(s.tmuxSession)}</code> · ${formatAgo(s.createdAt)}`);
          }
        }
        if (extRemoved.length > 0) {
          extLines.push(`🧹 Cleaned ${extRemoved.length} dead: ${extRemoved.map((s) => escapeHtml(s.name)).join(', ')}`);
        }
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>${extLines.join('\n')}</blockquote>`, 'HTML');
        break;
      }

      case 'killcc': {
        this.externalCc.cleanup();
        const extKillable = this.externalCc.list();
        if (extKillable.length === 0) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No external CC sessions to kill.</blockquote>', 'HTML');
          break;
        }
        const extKillKb = new InlineKeyboard();
        for (const s of extKillable) {
          extKillKb.text(`${s.name} (${s.repoName})${s.worktree ? ' 🌿' : ''}`, `extcc-kill:${s.windowId}`).row();
        }
        await agent.tgBot.sendTextWithKeyboard(cmd.chatId, '<b>Kill external CC session:</b>', extKillKb, 'HTML');
        break;
      }

      case 'restart': {
        // Restart the TGCC systemd service — this process will die and come back
        // Only notify supervisor chat — workers don't need the restart message
        if (this.nativeSupervisorId) {
          const supAgent = this.agents.get(this.nativeSupervisorId);
          const supChatId = supAgent ? this.getAgentChatId(supAgent) : null;
          if (supChatId && supAgent?.tgBot) {
            await supAgent.tgBot.sendText(supChatId, '<blockquote>🔄 Restarting TGCC service...</blockquote>', 'HTML');
          }
        }
        setTimeout(() => {
          nodeExec('systemctl --user restart tgcc', err => {
            if (err) this.logger.error({ err }, '/restart: systemctl failed');
          });
        }, 500);
        break;
      }

      case 'continue': {
        // Remember the current session before killing
        const contSession = cs.ccProcess?.sessionId
          ?? this.sessionStore.getSessionForChat(agentId, cmd.chatId) ?? undefined;
        this.killChatProcess(agentId, cmd.chatId);

        // Resolve session to resume and look up its title in one pass
        let sessionToResume = contSession;
        let sessionTitle: string | null = null;
        if (agent.repo) {
          const discovered = this.discoverAgentSessions(agent, 20);
          if (!sessionToResume && discovered.length > 0) {
            sessionToResume = discovered[0].id;
          }
          if (sessionToResume) {
            sessionTitle = discovered.find(s => s.id === sessionToResume)?.title ?? null;
          }
        }
        if (sessionToResume) {
          getOrCreateChatSession(agent, cmd.chatId).pendingSessionId = sessionToResume;
        }

        const contLines = ['Process respawned. Session kept.'];
        if (agent.repo) contLines.push(`📂 <code>${escapeHtml(shortenRepoPath(agent.repo))}</code>`);
        if (agent.model) contLines.push(`🤖 ${escapeHtml(agent.model)}`);
        if (sessionToResume) contLines.push(`📎 <code>${escapeHtml(sessionToResume.slice(0, 8))}</code>`);
        if (sessionTitle) contLines.push(`💬 ${escapeHtml(sessionTitle)}`);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>${contLines.join('\n')}</blockquote>`, 'HTML');
        break;
      }

      case 'sessions': {
        const repo = agent.repo;
        const currentSessionId = cs.ccProcess?.sessionId ?? null;
        const cliSessionId = cs.cliSessionId;

        // Discover sessions from CC's session directory
        const discovered = this.discoverAgentSessions(agent, 5);

        type MergedSession = { id: string; title: string; summary: string | null; age: string; detail: string; isCurrent: boolean; isCli: boolean };
        const merged: MergedSession[] = discovered.map(d => {
          const ctx = d.contextPct !== null ? ` · ${d.contextPct}% ctx` : '';
          const modelTag = d.model ? ` · ${shortModel(d.model)}` : '';
          return {
            id: d.id,
            title: d.title,
            summary: d.summary,
            age: formatAge(d.mtime),
            detail: `~${d.lineCount} entries${ctx}${modelTag}`,
            isCurrent: d.id === currentSessionId || d.id === cliSessionId,
            isCli: cliSessionId !== null && d.id === cliSessionId,
          };
        });

        if (merged.length === 0) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No sessions found.</blockquote>', 'HTML');
          break;
        }

        // Oldest first, most recent at bottom (reverse the mtime-desc order from discovery)
        merged.reverse();

        // One message per session, each with its own resume button
        for (const s of merged) {
          const displayTitle = escapeHtml(s.title);
          const kb = new InlineKeyboard();
          const summaryLine = s.summary ? `\n<i>${escapeHtml(s.summary.length > 150 ? s.summary.slice(0, 150) + '…' : s.summary)}</i>` : '';
          if (s.isCurrent) {
            const cliTag = (s.isCli || this.ctlServer.hasCliSession(agentId)) ? ' [CLI]' : '';
            const repoLine = repo ? `\n📂 <code>${escapeHtml(shortenRepoPath(repo))}</code>` : '';
            const sessModel = agent.model;
            const modelLine = sessModel ? `\n🤖 ${escapeHtml(sessModel)}` : '';
            const sessionLine = `\n📎 <code>${escapeHtml(s.id.slice(0, 8))}</code>`;
            const text = `<blockquote><b>Current session${cliTag}:</b>\n${displayTitle}${summaryLine}\n${s.detail} · ${s.age}${repoLine}${modelLine}${sessionLine}</blockquote>`;
            await agent.tgBot.sendText(cmd.chatId, text, 'HTML');
          } else {
            const text = `${displayTitle}${summaryLine}\n<code>${escapeHtml(s.id.slice(0, 8))}</code> · ${s.detail} · ${s.age}`;
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
        this.killChatProcess(agentId, cmd.chatId);
        getOrCreateChatSession(agent, cmd.chatId).pendingSessionId = cmd.args.trim();
        await agent.tgBot.sendText(cmd.chatId, `Will resume session <code>${escapeHtml(cmd.args.trim().slice(0, 8))}</code> on next message.`, 'HTML');
        break;
      }

      case 'session': {
        const currentSessionId = cs.ccProcess?.sessionId
          ?? this.sessionStore.getSessionForChat(agentId, cmd.chatId);
        if (!currentSessionId) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active session.</blockquote>', 'HTML');
          break;
        }
        const discovered = this.discoverAgentSessions(agent, 20);
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
        const oldModel = agent.model;
        agent.model = newModel;
        this.sessionStore.setModel(agentId, newModel);
        this.killChatProcess(agentId, cmd.chatId);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>Model set to <code>${escapeHtml(newModel)}</code>. Process respawned.</blockquote>`, 'HTML');
        // Emit state_changed event
        this.emitStateChanged(agentId, 'model', oldModel, newModel, 'telegram');
        break;
      }

      case 'repo': {
        const repoArgs = cmd.args?.trim().split(/\s+/) ?? [];
        const repoSub = repoArgs[0];
        this.logger.debug({ repoSub, repoArgs, repos: Object.keys(this.config.repos), hasArgs: !!cmd.args, argsRaw: cmd.args }, '/repo command debug');

        if (repoSub === 'add') {
          // /repo add <name> <path>
          const repoName = repoArgs[1];
          if (!repoName || !repoArgs[2]) {
            await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /repo add &lt;name&gt; &lt;path&gt;</blockquote>', 'HTML');
            break;
          }
          // Expand `~` and resolve to absolute — the filesystem never expands `~`,
          // so existsSync('~/foo') always fails and a raw `~` path stored in config
          // would later break the CC spawn cwd.
          const repoAddPath = expandPath(repoArgs[2]);
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
        // Kill all chats' processes (repo change = different CWD, affects every chat)
        const oldRepo = agent.repo;
        this.killAgentProcess(agentId);
        agent.repo = repoPath;
        this.sessionStore.clearSessionForChat(agentId, cmd.chatId); // clear this chat's session
        this.sessionStore.setRepo(agentId, repoPath);
        await agent.tgBot.sendText(cmd.chatId, `<blockquote>Repo set to <code>${escapeHtml(shortenRepoPath(repoPath))}</code>. Session cleared.</blockquote>`, 'HTML');
        // Emit state_changed event
        this.emitStateChanged(agentId, 'repo', oldRepo, repoPath, 'telegram');
        break;
      }

      case 'cancel': {
        if (this.ctlServer.hasCliSession(agentId)) {
          this.ctlServer.sendToCliSocket(agentId, { type: 'cli_cancel' });
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Cancelled (CLI session).</blockquote>', 'HTML');
        } else if (cs.ccProcess && cs.ccProcess.state === 'active') {
          cs.ccProcess.cancel();
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Cancelled.</blockquote>', 'HTML');
        } else {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active turn to cancel.</blockquote>', 'HTML');
        }
        break;
      }

      case 'compact': {
        if (!cs.ccProcess || cs.ccProcess.state !== 'active') {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No active session to compact. Start one first.</blockquote>', 'HTML');
          break;
        }
        const compactMsg = cmd.args?.trim()
          ? `/compact ${cmd.args.trim()}`
          : '/compact';
        await agent.tgBot.sendText(cmd.chatId, formatSystemMessage('status', 'Compacting…'), 'HTML');
        cs.ccProcess.sendMessage(createTextMessage(compactMsg));
        break;
      }

      case 'ralph': {
        const prompt = cmd.args?.trim() || 'Ensure the worker completes its current task successfully. Infer the goal from the session history and event log below.';
        const { ralphId, error: ralphError } = await this.spawnRalph({
          targetAgentId: agentId,
          prompt,
          invokerAgentId: agentId,
          invokerChatId: cmd.chatId,
        });
        if (ralphError) {
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>❌ ${escapeHtml(ralphError)}</blockquote>`, 'HTML');
        } else {
          await agent.tgBot.sendText(cmd.chatId,
            `<blockquote>🐕 Ralph spawned as <code>${ralphId}</code>, watching <code>${agentId}</code>\nPrompt: ${escapeHtml(prompt.slice(0, 120))}</blockquote>`, 'HTML');
        }
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
        keyboard.text('🔓 Bypass', 'permissions:dangerously-skip').text('🛂 Accept Edits', 'permissions:acceptEdits').row();
        keyboard.text('🔒 Default', 'permissions:default').text('📋 Plan', 'permissions:plan').row();

        await agent.tgBot.sendTextWithKeyboard(
          cmd.chatId,
          `Current: <code>${escapeHtml(currentMode)}</code>\nDefault: <code>${escapeHtml(agentDefault)}</code>\n\nSelect a mode for this session:`,
          keyboard,
          'HTML',
        );
        break;
      }

      case 'cron': {
        await this.handleCronCommand(agentId, cmd);
        break;
      }
    }
  }

  // ── Cron command handling ──

  private async handleCronCommand(agentId: string, cmd: SlashCommand): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent?.tgBot) return;

    const parts = (cmd.args ?? '').trim().split(/\s+/);
    const sub = parts[0] || 'list';

    switch (sub) {
      case 'list': {
        const jobs = this.scheduler.listJobs();
        if (jobs.length === 0) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>No cron jobs configured.</blockquote>', 'HTML');
          return;
        }

        const lines: string[] = ['<b>Cron Jobs</b>', ''];
        for (const job of jobs) {
          const sourceTag = job.source === 'static' ? '\uD83D\uDCCC' : '\uD83D\uDD04';
          const nextStr = job.nextRun ? formatAge(job.nextRun) : 'N/A';
          const oneShotTag = job.deleteAfterRun ? ' \uD83D\uDCA5one-shot' : '';
          const label = job.name ? `${job.name} (<code>${escapeHtml(job.id)}</code>)` : `<code>${escapeHtml(job.id)}</code>`;
          lines.push(`${sourceTag} ${label}`);
          lines.push(`   \u23F0 <code>${escapeHtml(job.schedule)}</code>${job.tz ? ` (${escapeHtml(job.tz)})` : ''}`);
          lines.push(`   \uD83D\uDCE8 ${escapeHtml(job.message.length > 60 ? job.message.slice(0, 60) + '\u2026' : job.message)}`);
          lines.push(`   \u27A1\uFE0F ${escapeHtml(job.agentId)} / ${job.session}${oneShotTag}`);
          lines.push(`   Next: ${nextStr}`);
          if (job.runCount !== undefined) lines.push(`   Runs: ${job.runCount}`);
          lines.push('');
        }

        await agent.tgBot.sendText(cmd.chatId, lines.join('\n'), 'HTML');
        return;
      }

      case 'add': {
        const result = this.parseCronAddArgs(agentId, parts.slice(1));
        if ('error' in result) {
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>\u274C ${escapeHtml(result.error)}</blockquote>`, 'HTML');
          return;
        }

        this.scheduler.addDynamicJob(
          result.job,
          (aid, text) => this.sendCronMessage(aid, text),
          (job) => this.spawnCronIsolated(job),
        );

        const nextRun = this.scheduler.listJobs().find(j => j.id === result.job.id)?.nextRun;
        const nextStr = nextRun ? nextRun.toISOString() : 'N/A';
        const oneShotLabel = result.job.deleteAfterRun ? ' (one-shot)' : '';
        await agent.tgBot.sendText(
          cmd.chatId,
          `<blockquote>\u2705 Cron job <code>${escapeHtml(result.job.id)}</code> added${oneShotLabel}\nSchedule: <code>${escapeHtml(result.job.schedule)}</code>\nNext run: ${escapeHtml(nextStr)}</blockquote>`,
          'HTML',
        );
        return;
      }

      case 'run': {
        const jobId = parts[1];
        if (!jobId) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /cron run &lt;id&gt;</blockquote>', 'HTML');
          return;
        }
        const triggered = this.scheduler.triggerJob(
          jobId,
          (aid, text) => this.sendCronMessage(aid, text),
          (job) => this.spawnCronIsolated(job),
        );
        if (triggered) {
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>\u2705 Cron job <code>${escapeHtml(jobId)}</code> triggered.</blockquote>`, 'HTML');
        } else {
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>\u274C Cron job <code>${escapeHtml(jobId)}</code> not found.</blockquote>`, 'HTML');
        }
        return;
      }

      case 'remove': {
        const jobId = parts[1];
        if (!jobId) {
          await agent.tgBot.sendText(cmd.chatId, '<blockquote>Usage: /cron remove &lt;id&gt;</blockquote>', 'HTML');
          return;
        }
        const removed = this.scheduler.removeDynamicJob(jobId);
        if (removed) {
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>\u2705 Cron job <code>${escapeHtml(jobId)}</code> removed.</blockquote>`, 'HTML');
        } else {
          await agent.tgBot.sendText(cmd.chatId, `<blockquote>\u274C Cron job <code>${escapeHtml(jobId)}</code> not found (only dynamic jobs can be removed).</blockquote>`, 'HTML');
        }
        return;
      }

      default: {
        const helpText = [
          '<b>Cron Commands</b>',
          '',
          '/cron list \u2014 Show all scheduled jobs',
          '/cron add --every 4h --message "check infra" --session isolated',
          '/cron add --at "20m" --message "follow up" --session main',
          '/cron add --cron "0 9 * * 1-5" --tz Europe/Madrid --message "standup"',
          '/cron run &lt;id&gt; \u2014 Trigger a job immediately',
          '/cron remove &lt;id&gt; \u2014 Remove a dynamic job',
        ].join('\n');
        await agent.tgBot.sendText(cmd.chatId, helpText, 'HTML');
        return;
      }
    }
  }

  /**
   * Parse /cron add arguments into a CronJobConfig.
   * Supports: --every, --at, --cron, --tz, --message, --session, --name, --announce
   */
  private parseCronAddArgs(
    agentId: string,
    tokens: string[],
  ): { job: CronJobConfig } | { error: string } {
    // Reassemble tokens into a single string for quoted-value parsing
    const raw = tokens.join(' ');

    // Parse named arguments with support for quoted values
    const args: Record<string, string> = {};
    const argPattern = /--(\w+)\s+(?:"([^"]*?)"|'([^']*?)'|(\S+))/g;
    let match: RegExpExecArray | null;
    while ((match = argPattern.exec(raw)) !== null) {
      args[match[1]] = match[2] ?? match[3] ?? match[4];
    }

    const message = args['message'] || args['msg'];
    if (!message) return { error: 'Missing --message argument.' };

    const session = (args['session'] ?? 'main') as 'main' | 'isolated';
    if (session !== 'main' && session !== 'isolated') {
      return { error: 'Session must be "main" or "isolated".' };
    }

    const tz = args['tz'];
    const name = args['name'];
    const announce = args['announce'] !== 'false'; // default true

    let schedule: string;
    let deleteAfterRun = false;

    if (args['at']) {
      // One-shot: compute schedule from relative/absolute time
      const result = computeOneShotSchedule(args['at']);
      if (!result) return { error: `Cannot parse --at value: "${args['at']}". Use e.g. "20m", "4h", or an ISO datetime.` };
      schedule = result.schedule;
      deleteAfterRun = true;
    } else if (args['every']) {
      // Recurring interval
      const cronExpr = parseEveryToCron(args['every']);
      if (!cronExpr) return { error: `Cannot parse --every value: "${args['every']}". Use e.g. "30m", "4h".` };
      schedule = cronExpr;
    } else if (args['cron']) {
      // Raw cron expression
      schedule = args['cron'];
    } else {
      return { error: 'Must specify --every, --at, or --cron.' };
    }

    // Generate a unique ID
    const id = name
      ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      : `dyn-${Date.now().toString(36)}`;

    // Check for ID collisions
    if (this.scheduler.hasJob(id)) {
      return { error: `Job ID "${id}" already exists. Use a different --name.` };
    }

    const job: CronJobConfig = {
      id,
      ...(name ? { name } : {}),
      schedule,
      ...(tz ? { tz } : {}),
      agentId,
      message,
      session,
      announce,
      deleteAfterRun,
    };

    return { job };
  }

  // ── Callback query handling (inline buttons) ──

  private async handleCallbackQuery(agentId: string, query: CallbackQuery): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (!agent.tgBot) return; // ephemeral agents don't have TG bots

    this.logger.debug({ agentId, action: query.action, data: query.data }, 'Callback query');

    // Per-chat session state for the chat this callback came from.
    const cs = getOrCreateChatSession(agent, query.chatId);

    switch (query.action) {
      case 'resume': {
        const sessionId = query.data;
        this.killChatProcess(agentId, query.chatId);
        getOrCreateChatSession(agent, query.chatId).pendingSessionId = sessionId;
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
        // Kill process if this chat is running this session
        if (cs.ccProcess?.sessionId === sessionId) {
          this.killChatProcess(agentId, query.chatId);
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
        const oldRepoCb = agent.repo;
        this.killAgentProcess(agentId);
        agent.repo = repoPath;
        this.sessionStore.clearSessionForChat(agentId, query.chatId);
        this.sessionStore.setRepo(agentId, repoPath);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Repo: ${repoName}`);
        await agent.tgBot.sendText(query.chatId, `<blockquote>Repo set to <code>${escapeHtml(shortenRepoPath(repoPath))}</code>. Session cleared.</blockquote>`, 'HTML');
        // Emit state_changed event
        this.emitStateChanged(agentId, 'repo', oldRepoCb, repoPath, 'telegram');
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
        const oldModelCb = agent.model;
        agent.model = model;
        this.sessionStore.setModel(agentId, model);
        this.killAgentProcess(agentId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, `Model: ${model}`);
        await agent.tgBot.sendText(query.chatId, `<blockquote>Model set to <code>${escapeHtml(model)}</code>. Process respawned.</blockquote>`, 'HTML');
        // Emit state_changed event
        this.emitStateChanged(agentId, 'model', oldModelCb, model, 'telegram');
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
        // AskUserQuestion needs answers in updatedInput; a bare allow makes CC
        // fall back to original input (no answers) and emit empty answersText.
        if (pending.toolName === 'AskUserQuestion') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Pick options above');
          break;
        }
        if (cs.ccProcess) {
          cs.ccProcess.respondToPermission(requestId, true);
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
        if (cs.ccProcess) {
          cs.ccProcess.respondToPermission(requestId, false);
        }
        agent.pendingPermissions.delete(requestId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '❌ Denied');
        break;
      }

      case 'perm_allow_all': {
        // Allow all pending permissions for this agent. Skip AskUserQuestion —
        // bare allow drops the user's answers and CC emits empty answersText.
        const toAllow: string[] = [];
        for (const [reqId, pending] of agent.pendingPermissions) {
          if (pending.toolName === 'AskUserQuestion') continue;
          toAllow.push(reqId);
        }
        for (const reqId of toAllow) {
          if (cs.ccProcess) cs.ccProcess.respondToPermission(reqId, true);
          agent.pendingPermissions.delete(reqId);
        }
        await agent.tgBot.answerCallbackQuery(
          query.callbackQueryId,
          `✅ Allowed ${toAllow.length} permission(s)`,
        );
        break;
      }

      case 'ask_pick': {
        // Single-select: data = "{requestId}:{qIdx}:{optIdx}"
        const [askReqId, qIdxStr, optIdxStr] = query.data.split(':');
        const pending = agent.pendingPermissions.get(askReqId);
        if (!pending || pending.toolName !== 'AskUserQuestion') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Question expired');
          break;
        }
        const questions = (pending.input?.questions ?? []) as AskQuestion[];
        const qi = parseInt(qIdxStr, 10);
        const oi = parseInt(optIdxStr, 10);
        const selected = getOptLabel(questions[qi]?.options?.[oi] ?? '');
        const answers = { ...(pending.questionAnswers ?? {}), [String(qi)]: [selected] };

        // Check if all questions are answered
        const allAnswered = questions.every((_, i) => answers[String(i)]?.length);
        if (allAnswered) {
          this.submitAskAnswer(agentId, pending, cs.ccProcess, questions, answers);
          agent.pendingPermissions.delete(askReqId);
          // Show confirmation on the message
          if (pending.questionMsgId && pending.questionChatId) {
            const summary = questions.map((q, i) => `<b>${escapeHtml(q.question)}</b>\n→ ${escapeHtml(answers[String(i)]?.[0] ?? '')}`).join('\n\n');
            agent.tgBot.editText(pending.questionChatId, pending.questionMsgId, `❓ ${summary}`, 'HTML').catch(() => {});
          }
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '✅ Answered');
        } else {
          // More questions remain — update answers and re-render
          pending.questionAnswers = answers;
          if (pending.questionMsgId && pending.questionChatId) {
            const { text, keyboard } = buildAskUi(askReqId, questions, answers);
            agent.tgBot.editTextWithKeyboard(pending.questionChatId, pending.questionMsgId, text, keyboard, 'HTML').catch(() => {});
          }
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '✓ Noted');
        }
        break;
      }

      case 'ask_toggle': {
        // Multi-select toggle: data = "{requestId}:{qIdx}:{optIdx}"
        const [askReqId, qIdxStr, optIdxStr] = query.data.split(':');
        const pending = agent.pendingPermissions.get(askReqId);
        if (!pending || pending.toolName !== 'AskUserQuestion') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Question expired');
          break;
        }
        const questions = (pending.input?.questions ?? []) as AskQuestion[];
        const qi = parseInt(qIdxStr, 10);
        const oi = parseInt(optIdxStr, 10);
        const opt = getOptLabel(questions[qi]?.options?.[oi] ?? '');
        const answers = { ...(pending.questionAnswers ?? {}) };
        const cur = answers[String(qi)] ?? [];
        answers[String(qi)] = cur.includes(opt) ? cur.filter(o => o !== opt) : [...cur, opt];
        pending.questionAnswers = answers;
        if (pending.questionMsgId && pending.questionChatId) {
          const { text, keyboard } = buildAskUi(askReqId, questions, answers);
          agent.tgBot.editTextWithKeyboard(pending.questionChatId, pending.questionMsgId, text, keyboard, 'HTML').catch(() => {});
        }
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId);
        break;
      }

      case 'ask_submit': {
        // Multi-select submit: data = "{requestId}:{qIdx}"
        const [askReqId] = query.data.split(':');
        const pending = agent.pendingPermissions.get(askReqId);
        if (!pending || pending.toolName !== 'AskUserQuestion') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Question expired');
          break;
        }
        const questions = (pending.input?.questions ?? []) as AskQuestion[];
        const answers = pending.questionAnswers ?? {};
        this.submitAskAnswer(agentId, pending, cs.ccProcess, questions, answers);
        agent.pendingPermissions.delete(askReqId);
        if (pending.questionMsgId && pending.questionChatId) {
          const summary = questions.map((q, i) => `<b>${escapeHtml(q.question)}</b>\n→ ${escapeHtml((answers[String(i)] ?? []).join(', ') || '(none)')}`).join('\n\n');
          agent.tgBot.editText(pending.questionChatId, pending.questionMsgId, `❓ ${summary}`, 'HTML').catch(() => {});
        }
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '✅ Submitted');
        break;
      }

      case 'ask_other': {
        // "Other" free-text: data = "{requestId}:{qIdx}"
        const [askReqId, qIdxStr] = query.data.split(':');
        const pending = agent.pendingPermissions.get(askReqId);
        if (!pending || pending.toolName !== 'AskUserQuestion') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Question expired');
          break;
        }
        pending.awaitingTextQIdx = parseInt(qIdxStr, 10);
        const questions = (pending.input?.questions ?? []) as AskQuestion[];
        const qText = escapeHtml(questions[pending.awaitingTextQIdx]?.question ?? '');
        if (pending.questionMsgId && pending.questionChatId) {
          agent.tgBot.editText(
            pending.questionChatId, pending.questionMsgId,
            `❓ <b>${qText}</b>\n\n✏️ <i>Type your answer in the chat…</i>`, 'HTML',
          ).catch(() => {});
        }
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Type your answer');
        break;
      }

      case 'plan_approve': {
        const toolUseId = query.data;
        const pending = agent.pendingPermissions.get(toolUseId);
        if (!pending || pending.toolName !== 'ExitPlanMode') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Plan request expired');
          break;
        }
        if (cs.ccProcess) cs.ccProcess.sendToolResult(toolUseId, 'approved');
        agent.pendingPermissions.delete(toolUseId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '✅ Plan approved');
        break;
      }

      case 'plan_reject': {
        const toolUseId = query.data;
        const pending = agent.pendingPermissions.get(toolUseId);
        if (!pending || pending.toolName !== 'ExitPlanMode') {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Plan request expired');
          break;
        }
        if (cs.ccProcess) cs.ccProcess.sendToolResult(toolUseId, 'rejected');
        agent.pendingPermissions.delete(toolUseId);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '❌ Plan rejected');
        break;
      }

      case 'exec_allow': {
        const approvalId = query.data;
        const pending = agent.pendingExecApprovals.get(approvalId);
        if (!pending) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Request expired');
          break;
        }
        clearTimeout(pending.timer);
        agent.pendingExecApprovals.delete(approvalId);
        pending.resolve(true);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '✅ Allowed');
        if (pending.msgId && pending.chatId) {
          agent.tgBot.editText(pending.chatId, pending.msgId, `✅ Exec approved: <code>${escapeHtml(pending.command)}</code>`, 'HTML').catch(() => {});
        }
        break;
      }

      case 'exec_deny': {
        const approvalId = query.data;
        const pending = agent.pendingExecApprovals.get(approvalId);
        if (!pending) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Request expired');
          break;
        }
        clearTimeout(pending.timer);
        agent.pendingExecApprovals.delete(approvalId);
        pending.resolve(false);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, '❌ Denied');
        if (pending.msgId && pending.chatId) {
          agent.tgBot.editText(pending.chatId, pending.msgId, `❌ Exec denied: <code>${escapeHtml(pending.command)}</code>`, 'HTML').catch(() => {});
        }
        break;
      }

      case 'cli-tmux': {
        // User picked an existing tmux session — open a new window
        const [targetAgent, tmuxSession] = query.data.split(':', 2);
        // Use the system-installed `tgcc` binary (in PATH) — NOT `process.argv[1]`,
        // which is the relative non-executable `dist/cli.js` under systemd.
        try {
          execSync(`tmux new-window -t ${JSON.stringify(tmuxSession)} "tgcc attach --agent ${targetAgent}"`, { stdio: 'ignore' });
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'CLI window created');
          await agent.tgBot.sendText(
            query.chatId,
            `<blockquote>CLI session created in tmux <code>${escapeHtml(tmuxSession)}</code>.\nAttach: <code>tmux attach -t ${escapeHtml(tmuxSession)}</code></blockquote>`,
            'HTML',
          );
        } catch (err) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Failed');
          await agent.tgBot.sendText(query.chatId, `<blockquote>Failed to create tmux window: ${escapeHtml(String(err))}</blockquote>`, 'HTML');
        }
        break;
      }

      case 'cli-tmux-new': {
        // User wants a new tmux session — ask for name via reply
        const targetAgent2 = query.data;
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Send session name');
        await agent.tgBot.sendText(
          query.chatId,
          `Reply with a name for the new tmux session (e.g. <code>dev</code>):`,
          'HTML',
        );
        // Store pending state to catch the next text message as the session name
        agent.pendingCliTmuxAgent = targetAgent2;
        break;
      }

      case 'extcc-w': {
        // Worktree yes/no answered for pending /newcc — next: repo keyboard
        const extPend = this.pendingExtCcNew.get(`${agentId}:${query.chatId}`);
        if (!extPend) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Expired — run /newcc again');
          break;
        }
        extPend.worktree = query.data === 'y';
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, extPend.worktree ? 'Worktree' : 'Repo checkout');
        await this.sendExtCcRepoKeyboard(agent, query.chatId, extPend.name, extPend.worktree);
        break;
      }

      case 'extcc-repo': {
        // Repo picked for pending /newcc — final step, create the session
        const extPendKey = `${agentId}:${query.chatId}`;
        const extPend = this.pendingExtCcNew.get(extPendKey);
        if (!extPend) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Expired — run /newcc again');
          break;
        }
        const extRepoPath = this.config.repos[query.data];
        if (!extRepoPath) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Unknown repo');
          break;
        }
        this.pendingExtCcNew.delete(extPendKey);
        await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Creating…');
        await this.createExternalCcSession(agent, query.chatId, extPend.name, {
          worktree: extPend.worktree ?? false,
          repoName: query.data,
          repoPath: extRepoPath,
        });
        break;
      }

      case 'extcc-kill': {
        const extVictim = this.externalCc.kill(query.data);
        if (extVictim) {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Killed');
          await agent.tgBot.sendText(
            query.chatId,
            `<blockquote>🗡 Killed external CC session <b>${escapeHtml(extVictim.name)}</b> (tmux <code>${escapeHtml(extVictim.tmuxSession)}</code>).</blockquote>`,
            'HTML',
          );
        } else {
          await agent.tgBot.answerCallbackQuery(query.callbackQueryId, 'Already gone');
          await agent.tgBot.sendText(query.chatId, '<blockquote>Session was no longer tracked — nothing to kill.</blockquote>', 'HTML');
        }
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

    // CLI has no originating chat — fall back to the agent's primary chat.
    const chatId = this.getAgentChatId(agent);
    const cs = chatId != null ? getOrCreateChatSession(agent, chatId) : undefined;

    // If explicit session requested, set it as pending
    if (sessionId && cs) {
      cs.pendingSessionId = sessionId;
    }

    // Route through the same sendToCC path as Telegram
    this.sendToCC(agentId, { text }, { spawnSource: 'cli' });

    return {
      type: 'ack',
      sessionId: cs?.ccProcess?.sessionId ?? null,
      state: cs?.ccProcess?.state ?? 'idle',
    };
  }

  handleCtlStatus(agentId?: string): CtlStatusResponse {
    const agents: CtlStatusResponse['agents'] = [];
    const sessions: CtlStatusResponse['sessions'] = [];

    const agentIds = agentId ? [agentId] : [...this.agents.keys()];

    for (const id of agentIds) {
      const agent = this.agents.get(id);
      if (!agent) continue;

      const primaryCs = this.getPrimaryChatSession(agent);
      const state = primaryCs?.ccProcess?.state ?? 'idle';

      agents.push({
        id,
        state,
        sessionId: primaryCs?.ccProcess?.sessionId ?? null,
        repo: agent.repo,
      });

      // List sessions from CC's session directory
      if (agent.repo) {
        for (const d of this.discoverAgentSessions(agent, 5)) {
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

    try {
      // Supervisor-routed tools (don't need TG chatId)
      switch (request.tool) {
        case 'notify_supervisor':
        case 'notify_parent': {
          // Route to external supervisor (OpenClaw plugin) if connected
          if (this.supervisorWrite) {
            this.sendToSupervisor({
              type: 'event',
              event: 'cc_message',
              agentId: request.agentId,
              text: request.params.message,
              priority: request.params.priority || 'info',
            });
          }
          // Route to native supervisor queue (always forward to TG — explicit worker communication)
          const priority = String(request.params.priority ?? 'info');
          const emoji = priority === 'blocker' ? '🚨' : 'ℹ️';
          this.pushSupervisorEvent(request.agentId, `${emoji} ${request.params.message as string}`, true, true);
          if (!this.supervisorWrite && !this.nativeSupervisorId) {
            return { id: request.id, success: false, error: 'No supervisor connected' };
          }
          return { id: request.id, success: true };
        }

        case 'supervisor_exec': {
          const timeoutMs = (request.params.timeoutMs as number) || 60000;
          const command = String(request.params.command ?? '');

          // Group permission check: if triggered from a group by a non-admin, require admin approval
          if (agent) {
            const chatId = agent.lastTgChatId;
            const userId = agent.lastTgUserId;
            const isGroup = chatId !== null && chatId < 0;
            const isAdmin = userId !== null && agent.config.allowedUsers.includes(String(userId));

            if (isGroup && !isAdmin && agent.tgBot) {
              // Find admin DM chat ID (first allowedUser)
              const adminId = agent.config.allowedUsers[0];
              if (!adminId) {
                return { id: request.id, success: false, error: 'No admin configured — cannot approve exec' };
              }
              const adminChatId = Number(adminId);

              // Send approval request to admin's DM
              const approvalId = randomUUID();
              const approved = await new Promise<boolean>((resolve) => {
                const timer = setTimeout(() => {
                  agent.pendingExecApprovals.delete(approvalId);
                  resolve(false);
                }, 60_000);
                agent.pendingExecApprovals.set(approvalId, { resolve, timer, command });

                const keyboard = new InlineKeyboard()
                  .text('✅ Allow', `exec_allow:${approvalId}`)
                  .text('❌ Deny', `exec_deny:${approvalId}`);
                const text = `⚡ <b>Exec request</b> from group:\n<code>${escapeHtml(command)}</code>\n\nRequested by user ${userId}`;
                agent.tgBot!.sendTextWithKeyboard(adminChatId, text, keyboard, 'HTML')
                  .then(msgId => {
                    const pending = agent.pendingExecApprovals.get(approvalId);
                    if (pending) { pending.msgId = msgId; pending.chatId = adminChatId; }
                  })
                  .catch(err => this.logger.error({ err }, 'Failed to send exec approval request'));
              });

              if (!approved) {
                return { id: request.id, success: false, error: 'Command denied or approval timed out' };
              }
            }
          }

          // Route to external supervisor plugin if connected
          if (this.supervisorWrite) {
            const result = await this.sendSupervisorRequest({
              type: 'command',
              requestId: randomUUID(),
              action: 'exec',
              params: {
                command,
                agentId: request.agentId,
                timeoutMs,
              },
            }, timeoutMs);
            return { id: request.id, success: true, result };
          }

          // Native fallback: execute locally on the host
          // Log it and notify supervisor TG chat so there's visibility
          this.logger.info({ command, agentId: request.agentId }, 'supervisor_exec: running locally (no external supervisor)');
          this.pushSupervisorEvent(request.agentId, `⚡ exec: \`${command}\``, true, true);
          try {
            const output = execSync(command, {
              timeout: timeoutMs,
              encoding: 'utf-8',
              maxBuffer: 1024 * 1024,
            });
            return { id: request.id, success: true, result: output };
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { id: request.id, success: false, error: `exec failed: ${msg}` };
          }
        }

        case 'supervisor_notify': {
          const title = String(request.params.title ?? '');
          const body = String(request.params.body ?? '');
          const priority = String(request.params.priority ?? 'active');

          // Route to external supervisor (OpenClaw plugin) if connected
          if (this.supervisorWrite) {
            this.sendToSupervisor({
              type: 'event',
              event: 'notification',
              agentId: request.agentId,
              title,
              body,
              priority,
            });
          }

          // Route to native supervisor's TG chat + event queue
          const notifyEmoji = priority === 'timeSensitive' ? '🚨' : priority === 'active' ? '🔔' : '📌';
          const notifyText = title ? `${notifyEmoji} <b>${escapeHtml(title)}</b>\n${escapeHtml(body)}` : `${notifyEmoji} ${escapeHtml(body)}`;
          if (this.nativeSupervisorId) {
            // Push to event queue (without TG — we send a richer message below)
            this.pushSupervisorEvent(request.agentId, `${notifyEmoji} ${title}: ${body}`, false);
            // Send a nicely formatted TG message to the supervisor's chat
            const supAgent = this.agents.get(this.nativeSupervisorId);
            if (supAgent?.tgBot) {
              const supChatId = this.getAgentChatId(supAgent);
              if (supChatId) {
                const silent = priority !== 'timeSensitive';
                supAgent.tgBot.sendText(
                  supChatId,
                  `<blockquote>[${escapeHtml(request.agentId)}] ${notifyText}</blockquote>`,
                  'HTML',
                  silent,
                ).catch(err => this.logger.warn({ err }, 'Failed to send supervisor_notify to supervisor TG'));
              }
            }
          }

          if (!this.supervisorWrite && !this.nativeSupervisorId) {
            return { id: request.id, success: false, error: 'No supervisor connected' };
          }
          return { id: request.id, success: true };
        }
      }

      // ── Agent orchestration tools (two-tier permissions) ──

      const workerAllowedTools = new Set([
        'tgcc_agents', 'tgcc_spawn', 'tgcc_send', 'tgcc_status', 'tgcc_log', 'tgcc_destroy',
        'ralph_done',
      ]);
      const supervisorOnlyTools = new Set([
        'tgcc_kill', 'tgcc_session', 'tgcc_cron', 'tgcc_track', 'tgcc_untrack',
        'tgcc_ralph',
      ]);

      if (workerAllowedTools.has(request.tool) || supervisorOnlyTools.has(request.tool)) {
        const isInternalCaller = request.userId === 'cron' || request.userId === 'system';
        // Supervisor-only tools: reject non-supervisor callers (ralph agents with 'manage' cap are allowed)
        if (supervisorOnlyTools.has(request.tool) &&
            request.agentId !== this.nativeSupervisorId &&
            !this.ralphManager.isRalph(request.agentId) &&
            !isInternalCaller) {
          this.logger.warn({ tool: request.tool, agentId: request.agentId, userId: request.userId }, 'Rejected supervisor-only tool from non-supervisor');
          return { id: request.id, success: false, error: 'Only the supervisor may use this tool' };
        }
        // Worker-allowed tools: verify calling agent exists
        if (workerAllowedTools.has(request.tool) &&
            !this.agents.has(request.agentId) && !isInternalCaller) {
          return { id: request.id, success: false, error: 'Unknown calling agent' };
        }

        if (supervisorOnlyTools.has(request.tool)) {
          this.logger.info({ tool: request.tool, agentId: request.agentId, userId: request.userId }, 'Supervisor-only tool allowed');
        }

        switch (request.tool) {
          case 'tgcc_agents': {
            const agents = [];
            for (const [aid, a] of this.agents) {
              agents.push({
                id: aid,
                repo: a.repo,
                model: a.model,
                state: this.getPrimaryChatSession(a)?.ccProcess?.state ?? 'idle',
                ephemeral: a.ephemeral,
                isSupervisor: aid === this.nativeSupervisorId,
              });
            }
            // Supervisor first so callers scanning the list top-down see the right
            // target for escalation before reaching for tgcc_send with a guessed agentId.
            agents.sort((a, b) => Number(b.isSupervisor) - Number(a.isSupervisor));
            return { id: request.id, success: true, result: agents };
          }

          case 'tgcc_status': {
            const targetId = request.params.agentId as string | undefined;
            const result: Record<string, unknown> = {};
            for (const [aid, a] of this.agents) {
              if (aid === this.nativeSupervisorId) continue;
              if (targetId && aid !== targetId) continue;
              const proc = this.getPrimaryChatSession(a)?.ccProcess;
              const agentState = this.sessionStore.getAgent(aid);
              const lastLog = a.eventBuffer.query({ limit: 1, offset: Math.max(0, a.eventBuffer.totalLines - 1) }).lines[0];
              const chats = [...a.chatSessions.values()].map(cs => ({
                chatId: cs.chatId,
                sessionId: cs.ccProcess?.sessionId ?? null,
                state: cs.ccProcess?.state ?? 'idle',
              }));
              result[aid] = {
                state: proc?.state ?? 'idle',
                sessionId: proc?.sessionId ?? null,
                ephemeral: a.ephemeral,
                repo: a.repo,
                model: a.model,
                lastActivity: agentState.lastActivity,
                lastActivitySummary: lastLog?.text ?? null,
                sessionCost: this.highSignalDetector.getSessionCost(aid),
                contextPct: this.highSignalDetector.getContextPercent(aid),
                tracked: this.supervisorManager?.isTracked(aid) ?? false,
                chats,
              };
            }
            return { id: request.id, success: true, result };
          }

          case 'tgcc_send': {
            const targetId = request.params.agentId as string;
            const text = request.params.text as string;
            const targetAgent = this.agents.get(targetId);
            if (!targetAgent) return { id: request.id, success: false, error: `Unknown agent: ${targetId}` };
            // Implicitly track this worker so its high-signal events are forwarded to supervisor TG
            this.supervisorManager?.track(targetId);
            // Agent-level MCP send — operate on the agent's primary chat session.
            const sendChatId = this.getAgentChatId(targetAgent);
            const sendCs = sendChatId != null ? getOrCreateChatSession(targetAgent, sendChatId) : undefined;
            if (request.params.newSession && sendCs) sendCs.forceNewSession = true;
            if (request.params.sessionId && sendCs) sendCs.pendingSessionId = request.params.sessionId as string;
            if (request.params.followUp && (!sendCs?.ccProcess || sendCs.ccProcess.state === 'idle')) {
              return { id: request.id, success: false, error: `Agent ${targetId} is not active (followUp=true)` };
            }
            this.sendSupervisorMessage(targetId, text, request.agentId);
            return { id: request.id, success: true, result: { agentId: targetId, state: sendCs?.ccProcess?.state ?? 'spawning' } };
          }

          case 'tgcc_kill': {
            const targetId = request.params.agentId as string;
            this.killAgentProcess(targetId);
            return { id: request.id, success: true };
          }

          case 'tgcc_log': {
            const targetId = request.params.agentId as string;
            const targetAgent = this.agents.get(targetId);
            if (!targetAgent) return { id: request.id, success: false, error: `Unknown agent: ${targetId}` };
            const result = targetAgent.eventBuffer.query({
              limit: (request.params.limit as number) ?? 50,
              since: request.params.since as number | undefined,
              type: request.params.type as string | undefined,
              grep: request.params.grep as string | undefined,
            });
            return { id: request.id, success: true, result };
          }

          case 'tgcc_session': {
            const targetId = request.params.agentId as string;
            const action = request.params.action as string;
            const targetAgent = this.agents.get(targetId);
            if (!targetAgent) return { id: request.id, success: false, error: `Unknown agent: ${targetId}` };

            // Agent-level MCP tool — operate on the agent's primary chat session.
            const targetChatId = this.getAgentChatId(targetAgent);
            const targetCs = targetChatId != null ? getOrCreateChatSession(targetAgent, targetChatId) : undefined;

            switch (action) {
              case 'list': {
                const sessions = this.discoverAgentSessions(targetAgent, (request.params.limit as number) ?? 10);
                return { id: request.id, success: true, result: sessions };
              }
              case 'new': {
                this.killAgentProcess(targetId);
                if (targetChatId != null) {
                  this.sessionStore.clearSessionForChat(targetId, targetChatId);
                  getOrCreateChatSession(targetAgent, targetChatId).forceNewSession = true;
                }
                const prompt = request.params.prompt as string | undefined;
                if (prompt) {
                  this.sendToCC(targetId, { text: prompt });
                }
                return { id: request.id, success: true, result: { prompt: prompt ?? null } };
              }
              case 'cancel': {
                targetCs?.ccProcess?.cancel();
                return { id: request.id, success: true };
              }
              case 'set_model': {
                const model = request.params.model as string;
                if (!model) return { id: request.id, success: false, error: 'model is required' };
                const previousModel = targetAgent.model ?? '';
                targetAgent.model = model;
                this.sessionStore.setModel(targetId, model);
                this.killAgentProcess(targetId);
                return { id: request.id, success: true, result: { model, previousModel } };
              }
              case 'continue': {
                const contSession = targetCs?.ccProcess?.sessionId
                  ?? (targetChatId != null ? this.sessionStore.getSessionForChat(targetId, targetChatId) : undefined)
                  ?? null;
                this.killAgentProcess(targetId);
                let sessionToResume = contSession;
                if (!sessionToResume && targetAgent.repo) {
                  const discovered = this.discoverAgentSessions(targetAgent, 1);
                  if (discovered.length > 0) sessionToResume = discovered[0].id;
                }
                if (sessionToResume && targetChatId != null) {
                  getOrCreateChatSession(targetAgent, targetChatId).pendingSessionId = sessionToResume;
                }
                return { id: request.id, success: true, result: { sessionId: sessionToResume } };
              }
              case 'resume': {
                const sessionId = request.params.sessionId as string;
                if (!sessionId) return { id: request.id, success: false, error: 'sessionId is required' };
                this.killAgentProcess(targetId);
                if (targetChatId != null) {
                  getOrCreateChatSession(targetAgent, targetChatId).pendingSessionId = sessionId;
                }
                return { id: request.id, success: true, result: { pendingSessionId: sessionId } };
              }
              case 'compact': {
                if (!targetCs?.ccProcess || targetCs.ccProcess.state !== 'active') {
                  return { id: request.id, success: false, error: 'No active CC process to compact' };
                }
                const instructions = request.params.instructions as string | undefined;
                const compactMsg = instructions ? `/compact ${instructions}` : '/compact';
                targetCs.ccProcess.sendMessage(createTextMessage(compactMsg));
                return { id: request.id, success: true, result: { sent: true } };
              }
              case 'set_repo': {
                const repo = request.params.repo as string;
                if (!repo) return { id: request.id, success: false, error: 'repo is required' };
                const previousRepo = targetAgent.repo ?? '';
                const repoPath = resolveRepoPath(this.config.repos, repo);
                targetAgent.repo = repoPath;
                if (targetChatId != null) this.sessionStore.clearSessionForChat(targetId, targetChatId);
                this.sessionStore.setRepo(targetId, repoPath);
                this.killAgentProcess(targetId);
                return { id: request.id, success: true, result: { repo: repoPath, previousRepo } };
              }
              case 'set_permissions': {
                const mode = request.params.mode as string;
                if (!mode) return { id: request.id, success: false, error: 'mode is required' };
                const validModes = ['dangerously-skip', 'acceptEdits', 'default', 'plan'];
                if (!validModes.includes(mode)) {
                  return { id: request.id, success: false, error: `Invalid mode: ${mode}. Valid: ${validModes.join(', ')}` };
                }
                const agentState = this.sessionStore.getAgent(targetId);
                const previousMode = agentState.permissionMode || targetAgent.config.defaults.permissionMode;
                this.sessionStore.setPermissionMode(targetId, mode);
                this.killAgentProcess(targetId);
                return { id: request.id, success: true, result: { mode, previousMode } };
              }
              default:
                return { id: request.id, success: false, error: `Unknown session action: ${action}` };
            }
          }

          case 'tgcc_spawn': {
            const spawnAgentId = (request.params.agentId as string) || `eph-${randomUUID().slice(0, 8)}`;
            const repo = request.params.repo as string;
            if (!repo) return { id: request.id, success: false, error: 'Missing required param: repo' };

            if (this.agents.has(spawnAgentId)) {
              return { id: request.id, success: false, error: `Agent already exists: ${spawnAgentId}` };
            }

            // Map permission mode
            let permMode: 'dangerously-skip' | 'acceptEdits' | 'default' | 'plan' = 'default';
            const reqPerm = request.params.permissionMode as string | undefined;
            if (reqPerm === 'bypassPermissions' || reqPerm === 'dangerously-skip') permMode = 'dangerously-skip';
            else if (reqPerm === 'acceptEdits') permMode = 'acceptEdits';
            else if (reqPerm === 'plan') permMode = 'plan';

            // Compose --allowed-tools / --disallowed-tools from spawn params. These pass
            // through the existing ccExtraArgs plumbing into cc-process.ts buildArgs, so
            // the child CC's tool surface is restricted at the CC permission layer (not
            // just by prompt instruction). Critical for L1 scorers handling adversarial
            // user-message corpus where prompt obedience isn't a safe restriction.
            const allowedTools = Array.isArray(request.params.allowedTools) ? request.params.allowedTools as string[] : undefined;
            const disallowedTools = Array.isArray(request.params.disallowedTools) ? request.params.disallowedTools as string[] : undefined;
            const extraArgsParts: string[] = [];
            if (allowedTools && allowedTools.length > 0) {
              extraArgsParts.push('--allowed-tools', allowedTools.join(','));
            }
            if (disallowedTools && disallowedTools.length > 0) {
              extraArgsParts.push('--disallowed-tools', disallowedTools.join(','));
            }
            const ccExtraArgs = extraArgsParts.length > 0 ? extraArgsParts.join(' ') : undefined;

            const ephemeralConfig: AgentConfig = {
              botToken: '',
              allowedUsers: [],
              defaults: {
                model: (request.params.model as string) || 'sonnet',
                repo,
                idleTimeoutMs: 300_000,
                hangTimeoutMs: 300_000,
                permissionMode: permMode,
                ...(ccExtraArgs ? { ccExtraArgs } : {}),
              },
            };

            const instance: AgentInstance = {
              id: spawnAgentId,
              config: ephemeralConfig,
              tgBot: null,
              ephemeral: true,
              repo,
              model: ephemeralConfig.defaults.model,
              chatSessions: new Map(),
              pendingPermissions: new Map(),
      pendingExecApprovals: new Map(),
      lastTgChatId: null,
      lastTgUserId: null,
              destroyTimer: null,
              eventBuffer: new EventBuffer(),
              awaitingAskCleanup: false,
              muteOutput: false,
              authFlowInProgress: false,
              lastSendData: null,
              claudeConfigDir: undefined,
              pendingCliTmuxAgent: null,
            };

            // Auto-destroy timer
            const timeoutMs = request.params.timeoutMs as number | undefined;
            if (timeoutMs && timeoutMs > 0) {
              instance.destroyTimer = setTimeout(() => {
                this.logger.info({ agentId: spawnAgentId, timeoutMs }, 'Ephemeral agent timeout — auto-destroying');
                this.destroyEphemeralAgent(spawnAgentId);
              }, timeoutMs);
            }

            this.agents.set(spawnAgentId, instance);
            this.logger.info({ agentId: spawnAgentId, repo, model: instance.model, ephemeral: true }, 'Ephemeral agent spawned via tgcc_spawn');

            // Emit agent_created event
            this.sendToSupervisor({ type: 'event', event: 'agent_created', agentId: spawnAgentId, agentType: 'ephemeral', repo });
            this.pushSupervisorEvent(spawnAgentId, `🆕 Ephemeral agent created (${repo})`, true, false, 'routine');

            // If an initial message was provided, send it immediately
            const message = request.params.message as string | undefined;
            const waitForResult = request.params.waitForResult as boolean | undefined;

            if (waitForResult) {
              if (!message) {
                this.destroyEphemeralAgent(spawnAgentId);
                return { id: request.id, success: false, error: 'waitForResult requires a message' };
              }

              // Mute TG output — result goes to caller, not Telegram
              instance.muteOutput = true;

              // Clear auto-destroy timer — waitForResult timer handles lifecycle
              if (instance.destroyTimer) { clearTimeout(instance.destroyTimer); instance.destroyTimer = null; }

              const effectiveTimeout = timeoutMs || 120_000;

              // Send the message to start the agent
              this.sendSupervisorMessage(spawnAgentId, message, request.agentId);

              return new Promise<McpToolResponse>((resolve) => {
                const timer = setTimeout(() => {
                  this.pendingWaitForResult.delete(spawnAgentId);
                  this.destroyEphemeralAgent(spawnAgentId);
                  resolve({ id: request.id, success: false, error: `waitForResult timed out after ${effectiveTimeout}ms` });
                }, effectiveTimeout);

                this.pendingWaitForResult.set(spawnAgentId, {
                  resolve: (response) => resolve({ ...response, id: request.id }),
                  timer,
                });
              });
            }

            if (message) {
              this.sendSupervisorMessage(spawnAgentId, message, request.agentId);
            }

            return { id: request.id, success: true, result: { agentId: spawnAgentId, state: message ? 'spawning' : 'idle', repo, model: instance.model } };
          }

          case 'tgcc_destroy': {
            const targetId = request.params.agentId as string;
            if (!targetId) return { id: request.id, success: false, error: 'Missing agentId' };

            const targetAgent = this.agents.get(targetId);
            if (!targetAgent) return { id: request.id, success: false, error: `Unknown agent: ${targetId}` };
            if (!targetAgent.ephemeral) return { id: request.id, success: false, error: `Cannot destroy persistent agent: ${targetId}` };

            this.destroyEphemeralAgent(targetId);
            return { id: request.id, success: true, result: { destroyed: true, agentId: targetId } };
          }

          case 'tgcc_ralph': {
            const targetId = request.params.agentId as string;
            if (!targetId) return { id: request.id, success: false, error: 'agentId is required' };
            const prompt = (request.params.prompt as string) || 'Ensure the worker completes its current task successfully. Infer the goal from the session history and event log below.';
            const spec = request.params.spec as string | undefined;

            // Determine invoker chat for TG notifications
            const invokerAgent = this.agents.get(request.agentId);
            const invokerChatId = invokerAgent ? (this.getAgentChatId(invokerAgent) ?? 0) : 0;

            const { ralphId, error } = await this.spawnRalph({
              targetAgentId: targetId,
              prompt,
              spec,
              invokerAgentId: request.agentId,
              invokerChatId,
              timeoutMs: request.params.timeoutMs as number | undefined,
              minTurns: request.params.minTurns as number | undefined,
            });

            if (error) return { id: request.id, success: false, error };
            return { id: request.id, success: true, result: { ralphId, targetAgentId: targetId, state: 'spawning' } };
          }

          case 'ralph_done': {
            if (!this.ralphManager.isRalph(request.agentId)) {
              return { id: request.id, success: false, error: 'Only Ralph agents can call ralph_done' };
            }

            const summary = request.params.summary as string || 'No summary provided';
            const success = (request.params.success as boolean) ?? true;

            const result = this.ralphManager.done(request.agentId, summary, success);
            if (result.error) return { id: request.id, success: false, error: result.error };

            this.destroyEphemeralAgent(request.agentId);
            return { id: request.id, success: true, result: { destroyed: true } };
          }

          case 'tgcc_track': {
            const targetId = request.params.agentId as string;
            if (!targetId) return { id: request.id, success: false, error: 'agentId is required' };
            const targetAgent = this.agents.get(targetId);
            if (!targetAgent) return { id: request.id, success: false, error: `Unknown agent: ${targetId}` };
            this.supervisorManager?.track(targetId);
            // Start/update heartbeat if requested
            const heartbeatMs = request.params.heartbeatMs as number | undefined;
            if (heartbeatMs && heartbeatMs >= 30_000) {
              this.startHeartbeat(heartbeatMs);
            }
            this.logger.info({ targetId, heartbeatMs }, 'Supervisor tracking worker');
            return {
              id: request.id, success: true,
              result: { agentId: targetId, tracked: true, heartbeatMs: this.supervisorManager?.getHeartbeatInterval() || null },
            };
          }

          case 'tgcc_untrack': {
            const targetId = request.params.agentId as string;
            if (!targetId) return { id: request.id, success: false, error: 'agentId is required' };
            const wasTracked = this.supervisorManager?.untrack(targetId) ?? false;
            // Stop heartbeat if no more tracked workers
            if (this.supervisorManager && this.supervisorManager.trackedWorkers.size === 0) this.stopHeartbeat();
            this.logger.info({ targetId, wasTracked }, 'Supervisor untracking worker');
            return { id: request.id, success: true, result: { agentId: targetId, tracked: false, wasTracked } };
          }

          case 'tgcc_cron': {
            const action = request.params.action as string;

            switch (action) {
              case 'list': {
                const jobs = this.scheduler.listJobs();
                return { id: request.id, success: true, result: jobs };
              }

              case 'add': {
                const rawTargetId = request.params.agentId as string;
                // "self" resolves to the requesting agent's own ID
                const targetId = rawTargetId === 'self' ? request.agentId : rawTargetId;
                if (!targetId) return { id: request.id, success: false, error: 'agentId is required for add' };
                if (!this.agents.has(targetId)) return { id: request.id, success: false, error: `Unknown agent: ${targetId}` };
                const message = request.params.message as string;
                if (!message) return { id: request.id, success: false, error: 'message is required for add' };

                const session = (request.params.session as string) ?? 'main';
                const tz = request.params.tz as string | undefined;
                const name = request.params.name as string | undefined;

                let schedule: string;
                let deleteAfterRun = false;

                if (request.params.at) {
                  const result = computeOneShotSchedule(request.params.at as string);
                  if (!result) return { id: request.id, success: false, error: `Cannot parse --at value: "${request.params.at}"` };
                  schedule = result.schedule;
                  deleteAfterRun = true;
                } else if (request.params.every) {
                  const cronExpr = parseEveryToCron(request.params.every as string);
                  if (!cronExpr) return { id: request.id, success: false, error: `Cannot parse --every value: "${request.params.every}"` };
                  schedule = cronExpr;
                } else if (request.params.cron) {
                  schedule = request.params.cron as string;
                } else {
                  return { id: request.id, success: false, error: 'Must specify every, at, or cron' };
                }

                const jobId = name
                  ? name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
                  : `dyn-${Date.now().toString(36)}`;

                if (this.scheduler.hasJob(jobId)) {
                  return { id: request.id, success: false, error: `Job ID "${jobId}" already exists` };
                }

                const job: CronJobConfig = {
                  id: jobId,
                  ...(name ? { name } : {}),
                  schedule,
                  ...(tz ? { tz } : {}),
                  agentId: targetId,
                  message,
                  session: session as 'main' | 'isolated',
                  announce: true,
                  deleteAfterRun,
                };

                this.scheduler.addDynamicJob(
                  job,
                  (aid, text) => this.sendCronMessage(aid, text),
                  (j) => this.spawnCronIsolated(j),
                );

                const nextRun = this.scheduler.listJobs().find(j => j.id === jobId)?.nextRun;
                return {
                  id: request.id, success: true,
                  result: { jobId, schedule, deleteAfterRun, nextRun: nextRun?.toISOString() ?? null },
                };
              }

              case 'remove': {
                const jobId = request.params.jobId as string;
                if (!jobId) return { id: request.id, success: false, error: 'jobId is required for remove' };
                const removed = this.scheduler.removeDynamicJob(jobId);
                if (!removed) return { id: request.id, success: false, error: `Job "${jobId}" not found (only dynamic jobs can be removed)` };
                return { id: request.id, success: true, result: { removed: true, jobId } };
              }

              case 'trigger': {
                const jobId = request.params.jobId as string;
                if (!jobId) return { id: request.id, success: false, error: 'jobId is required for trigger' };
                const triggered = this.scheduler.triggerJob(
                  jobId,
                  (aid, text) => this.sendCronMessage(aid, text),
                  (j) => this.spawnCronIsolated(j),
                );
                if (!triggered) return { id: request.id, success: false, error: `Job "${jobId}" not found` };
                return { id: request.id, success: true, result: { triggered: true, jobId } };
              }

              default:
                return { id: request.id, success: false, error: `Unknown cron action: ${action}` };
            }
          }
        }
      }

      // Ralph agents don't have their own TG chat — route send_message through invoker
      if (request.tool === 'send_message') {
        const ralphResult = await this.ralphManager.routeSendMessage(request.agentId, request.params.text);
        if (ralphResult) {
          return { id: request.id, success: ralphResult.success, error: ralphResult.error };
        }
      }

      // TG tools (need chatId and tgBot) — route to the calling CC process's chat
      // (TGCC_CHAT_ID), falling back to the primary chat for agent-level callers.
      const chatId = request.chatId ?? this.getAgentChatId(agent);
      if (!chatId || !agent.tgBot) {
        return { id: request.id, success: false, error: `No chat ID for agent: ${request.agentId}` };
      }
      const toolCs = getChatSession(agent, chatId);

      switch (request.tool) {
        case 'send_file':
          if (toolCs?.accumulator) { await toolCs.accumulator.flushIfDirty(); toolCs.accumulator.reset(); }
          await agent.tgBot.sendFile(chatId, request.params.path, request.params.caption);
          return { id: request.id, success: true };

        case 'send_image':
          if (toolCs?.accumulator) { await toolCs.accumulator.flushIfDirty(); toolCs.accumulator.reset(); }
          await agent.tgBot.sendImage(chatId, request.params.path, request.params.caption);
          return { id: request.id, success: true };

        case 'send_message':
          await agent.tgBot.sendText(chatId, escapeHtml(request.params.text), 'HTML');
          return { id: request.id, success: true };

        case 'send_voice':
          if (toolCs?.accumulator) { await toolCs.accumulator.flushIfDirty(); toolCs.accumulator.reset(); }
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
    let msg: { type: string; requestId?: string; action?: string; params?: Record<string, unknown>; result?: unknown; error?: string };
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendToSupervisor({ type: 'error', message: 'Invalid JSON' });
      return;
    }

    // Handle responses to commands we sent to the supervisor (e.g. exec results)
    if (msg.type === 'response' && msg.requestId) {
      const pending = this.supervisorPendingRequests.get(msg.requestId);
      if (pending) {
        clearTimeout(pending.timer);
        this.supervisorPendingRequests.delete(msg.requestId);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
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

  // ── CLI session handlers (CtlHandler interface) ──

  handleCliAttach(agentId: string, repo: string, _writeFn: (line: string) => void): CtlCliAttachedResponse {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}`);

    // Kill any active stdin CC across all chats — CLI always wins on attach
    const hadProcess = [...agent.chatSessions.values()].some(c => c.ccProcess);
    if (hadProcess) {
      this.logger.info({ agentId }, 'CLI attach: yanking stdin CC');
      this.killAgentProcess(agentId);
      const tgChatId = this.getAgentChatId(agent);
      if (tgChatId && agent.tgBot) {
        agent.tgBot.sendText(tgChatId, '<blockquote>⚡ Stdin CC released — CLI took over this session.</blockquote>', 'HTML', true)
          .catch(err => this.logger.warn({ err }, 'Failed to send CLI takeover notification'));
      }
    }

    // Update repo if provided
    if (repo) agent.repo = repo;

    // Generate MCP config for the CLI session
    const mcpServerPath = resolveMcpServerPath();
    const mcpConfigPath = generateMcpConfig(
      agentId,
      agent.config.allowedUsers[0] ?? 'cli',
      this.config.global.socketDir,
      mcpServerPath,
      [],
      this.config.global.mcpConfigDir,
      undefined,
      agent.repo,
    );

    this.logger.info({ agentId, mcpConfigPath }, 'CLI session attached');
    return { type: 'cli_attached', mcpConfigPath };
  }

  handleCliEvent(agentId: string, event: string, data: Record<string, unknown>): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    switch (event) {
      case 'state': {
        const state = data.state as string;
        this.logger.debug({ agentId, state }, 'CLI state event');
        // Update typing indicator based on CLI state
        if (state === 'thinking' && agent.tgBot && agent.lastTgChatId) {
          this.startTypingIndicator(agent, agent.lastTgChatId);
        } else if (state === 'idle' && agent.lastTgChatId) {
          this.stopTypingIndicator(agent, agent.lastTgChatId);
        }
        break;
      }
      case 'session': {
        const sessionId = data.sessionId as string;
        // CLI has no originating chat — track on the agent's primary chat session.
        const cliChatId = this.getAgentChatId(agent);
        if (cliChatId != null) {
          getOrCreateChatSession(agent, cliChatId).cliSessionId = sessionId;
          this.sessionStore.setSessionForChat(agentId, cliChatId, sessionId);
        }
        this.sessionStore.updateLastActivity(agentId);
        this.logger.info({ agentId, sessionId }, 'CLI session tracked');
        break;
      }
    }
  }

  handleCliDetach(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;

    const detachChatId = this.getAgentChatId(agent);
    const detachCs = detachChatId != null ? getChatSession(agent, detachChatId) : undefined;
    this.logger.info({ agentId, cliSessionId: detachCs?.cliSessionId }, 'CLI session detached');
    if (detachCs) detachCs.cliSessionId = null;
    if (detachChatId != null) this.stopTypingIndicator(agent, detachChatId);

    // Notify TG
    if (agent.tgBot && agent.lastTgChatId) {
      agent.tgBot.sendText(agent.lastTgChatId, formatSystemMessage('status', 'CLI session ended'), 'HTML').catch(() => {});
    }
  }

  private handleSupervisorCommand(action: string, params: Record<string, unknown>): unknown {
    switch (action) {
      case 'ping':
        return { pong: true, uptime: process.uptime() };

      // ── Phase 2: Ephemeral agents ──

      case 'create_agent': {
        const agentId = (params.agentId as string) || `oc-spawn-${randomUUID().slice(0, 8)}`;
        const repo = params.repo as string;
        if (!repo) throw new Error('Missing required param: repo');

        if (this.agents.has(agentId)) {
          throw new Error(`Agent already exists: ${agentId}`);
        }

        // Map supervisor permissionMode to CC permissionMode
        let permMode: 'dangerously-skip' | 'acceptEdits' | 'default' | 'plan' = 'default';
        const reqPerm = params.permissionMode as string | undefined;
        if (reqPerm === 'bypassPermissions' || reqPerm === 'dangerously-skip') permMode = 'dangerously-skip';
        else if (reqPerm === 'acceptEdits') permMode = 'acceptEdits';
        else if (reqPerm === 'plan') permMode = 'plan';

        const ephemeralConfig: AgentConfig = {
          botToken: '',
          allowedUsers: [],
          defaults: {
            model: (params.model as string) || 'sonnet',
            repo,
            idleTimeoutMs: 300_000,
            hangTimeoutMs: 300_000,
            permissionMode: permMode,
          },
        };

        const instance: AgentInstance = {
          id: agentId,
          config: ephemeralConfig,
          tgBot: null,
          ephemeral: true,
          repo,
          model: ephemeralConfig.defaults.model,
          chatSessions: new Map(),
          pendingPermissions: new Map(),
      pendingExecApprovals: new Map(),
      lastTgChatId: null,
      lastTgUserId: null,
          destroyTimer: null,
          eventBuffer: new EventBuffer(),
          awaitingAskCleanup: false,
          muteOutput: false,
      authFlowInProgress: false,
      lastSendData: null,
      claudeConfigDir: undefined,
      pendingCliTmuxAgent: null,
        };

        // Auto-destroy timer
        const timeoutMs = params.timeoutMs as number | undefined;
        if (timeoutMs && timeoutMs > 0) {
          instance.destroyTimer = setTimeout(() => {
            this.logger.info({ agentId, timeoutMs }, 'Ephemeral agent timeout — auto-destroying');
            this.destroyEphemeralAgent(agentId);
          }, timeoutMs);
        }

        this.agents.set(agentId, instance);
        this.logger.info({ agentId, repo, model: instance.model, ephemeral: true }, 'Ephemeral agent created');

        // Emit agent_created event
        this.sendToSupervisor({ type: 'event', event: 'agent_created', agentId, agentType: 'ephemeral', repo });
        this.pushSupervisorEvent(agentId, `🆕 Ephemeral agent created (${repo})`, true, false, 'routine');

        return { agentId, state: 'idle' };
      }

      case 'destroy_agent': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        if (!agent.ephemeral) throw new Error(`Cannot destroy persistent agent: ${agentId}`);

        this.destroyEphemeralAgent(agentId);
        return { destroyed: true };
      }

      // ── Phase 1: Send + Subscribe ──

      case 'send_message': {
        const agentId = params.agentId as string;
        const text = params.text as string;
        if (!agentId || !text) throw new Error('Missing agentId or text');

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);

        // Auto-subscribe supervisor
        this.supervisorSubscriptions.add(`${agentId}:*`);

        // Agent-level supervisor message — route to the agent's primary chat session.
        const smChatId = this.getAgentChatId(agent);
        const smCs = smChatId != null ? getChatSession(agent, smChatId) : undefined;

        // For persistent agents: route supervisor message through the accumulator so it
        // appears inline in the current bubble. Fall back to a standalone silent message
        // if no accumulator is active or the previous turn is already sealed (agent idle).
        if (smCs?.accumulator && !smCs.accumulator.sealed) {
          smCs.accumulator.addSupervisorMessage(text);
        } else {
          if (smChatId != null && agent.tgBot) {
            const preview = text.length > 500 ? text.slice(0, 500) + '…' : text;
            agent.tgBot.sendText(smChatId, `<blockquote>🦞 ${escapeHtml(preview)}</blockquote>`, 'HTML', true) // silent
              .catch(err => this.logger.error({ err, agentId }, 'Failed to send supervisor TG notification'));
          }
        }

        // Send to the agent's primary chat CC process
        this.sendToCC(agentId, { text }, { spawnSource: 'supervisor' });

        return {
          sessionId: smCs?.ccProcess?.sessionId ?? null,
          state: smCs?.ccProcess?.state ?? 'spawning',
          subscribed: true,
        };
      }

      case 'send_to_cc': {
        const agentId = params.agentId as string;
        const text = params.text as string;
        if (!agentId || !text) throw new Error('Missing agentId or text');

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);

        const stcChatId = this.getAgentChatId(agent);
        const stcCs = stcChatId != null ? getChatSession(agent, stcChatId) : undefined;
        if (!stcCs?.ccProcess || stcCs.ccProcess.state === 'idle') {
          throw new Error(`No active CC process for agent ${agentId}`);
        }

        stcCs.ccProcess.sendMessage(createTextMessage(text));
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

          const statusCs = this.getPrimaryChatSession(agent);
          const state = statusCs?.ccProcess?.state ?? 'idle';
          const sessionId = statusCs?.ccProcess?.sessionId ?? null;

          agents.push({
            id,
            type: agent.ephemeral ? 'ephemeral' : 'persistent',
            state,
            repo: agent.repo,
            process: statusCs?.ccProcess ? { sessionId, model: agent.model } : null,
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

        const killed = !this.agentIsIdle(agentId);
        if (killed) {
          this.killAgentProcess(agentId);
        }

        return { killed };
      }

      // ── Phase A: Observability ──

      case 'get_log': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);

        return agent.eventBuffer.query({
          offset: params.offset as number | undefined,
          limit: params.limit as number | undefined,
          grep: params.grep as string | undefined,
          since: params.since as number | undefined,
          type: params.type as string | undefined,
        });
      }

      case 'permission_response': {
        const agentId = params.agentId as string;
        const permissionRequestId = params.permissionRequestId as string;
        const decision = params.decision as string;
        if (!agentId || !permissionRequestId || !decision) {
          throw new Error('Missing agentId, permissionRequestId, or decision');
        }

        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);

        const pending = agent.pendingPermissions.get(permissionRequestId);
        if (!pending) throw new Error(`No pending permission with id: ${permissionRequestId}`);

        // AskUserQuestion needs answers in updatedInput; route bare allow/deny
        // back through ask_submit/ask_other in TG so the user picks options.
        if (pending.toolName === 'AskUserQuestion') {
          throw new Error('AskUserQuestion must be answered via TG question card, not bare permission_response');
        }

        const allow = decision === 'allow';
        // Permission belongs to a specific chat — use the question's chat if recorded,
        // else fall back to the agent's primary chat.
        const permCs = pending.questionChatId != null
          ? getChatSession(agent, pending.questionChatId)
          : this.getPrimaryChatSession(agent);
        if (permCs?.ccProcess) {
          permCs.ccProcess.respondToPermission(permissionRequestId, allow);
        }
        agent.pendingPermissions.delete(permissionRequestId);

        return { responded: true, decision };
      }

      // ── Phase B: Session management ──

      case 'session_new': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        this.killAgentProcess(agentId);
        // Agent-level — pin a fresh session on the agent's primary chat.
        const snChatId = this.getAgentChatId(agent);
        if (snChatId != null) {
          this.sessionStore.clearSessionForChat(agentId, snChatId);
          getOrCreateChatSession(agent, snChatId).forceNewSession = true;
        }
        return { cleared: true };
      }

      case 'session_continue': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const scChatId = this.getAgentChatId(agent);
        const contSession = (scChatId != null ? getChatSession(agent, scChatId)?.ccProcess?.sessionId : null)
          ?? (scChatId != null ? this.sessionStore.getSessionForChat(agentId, scChatId) : undefined)
          ?? null;
        this.killAgentProcess(agentId);
        let sessionToResume = contSession;
        if (!sessionToResume && agent.repo) {
          const discovered = this.discoverAgentSessions(agent, 1);
          if (discovered.length > 0) sessionToResume = discovered[0].id;
        }
        if (sessionToResume && scChatId != null) {
          getOrCreateChatSession(agent, scChatId).pendingSessionId = sessionToResume;
        }
        return { sessionId: sessionToResume };
      }

      case 'session_resume': {
        const agentId = params.agentId as string;
        const sessionId = params.sessionId as string;
        if (!agentId) throw new Error('Missing agentId');
        if (!sessionId) throw new Error('Missing sessionId');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        this.killAgentProcess(agentId);
        const srChatId = this.getAgentChatId(agent);
        if (srChatId != null) {
          getOrCreateChatSession(agent, srChatId).pendingSessionId = sessionId;
        }
        return { pendingSessionId: sessionId };
      }

      case 'session_list': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const limit = (params.limit as number | undefined) ?? 10;
        const currentSessionId = this.getPrimaryChatSession(agent)?.ccProcess?.sessionId ?? null;
        const discovered = this.discoverAgentSessions(agent, limit);
        const sessions = discovered.map(d => ({
          id: d.id,
          title: d.title,
          age: formatAge(d.mtime),
          lineCount: d.lineCount,
          contextPct: d.contextPct ?? null,
          model: d.model ?? null,
          isCurrent: d.id === currentSessionId,
        }));
        return { sessions };
      }

      case 'set_model': {
        const agentId = params.agentId as string;
        const model = params.model as string;
        if (!agentId) throw new Error('Missing agentId');
        if (!model) throw new Error('Missing model');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const previousModel = agent.model ?? '';
        agent.model = model;
        this.sessionStore.setModel(agentId, model);
        this.killAgentProcess(agentId);
        this.emitStateChanged(agentId, 'model', previousModel, model, 'supervisor');
        return { model, previousModel };
      }

      case 'set_repo': {
        const agentId = params.agentId as string;
        const repo = params.repo as string;
        if (!agentId) throw new Error('Missing agentId');
        if (!repo) throw new Error('Missing repo');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const previousRepo = agent.repo ?? '';
        const repoPath = resolveRepoPath(this.config.repos, repo);
        agent.repo = repoPath;
        const srpChatId = this.getAgentChatId(agent);
        if (srpChatId != null) this.sessionStore.clearSessionForChat(agentId, srpChatId);
        this.sessionStore.setRepo(agentId, repoPath);
        this.killAgentProcess(agentId);
        return { repo: repoPath, previousRepo };
      }

      case 'cancel_turn': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        if (this.ctlServer.hasCliSession(agentId)) {
          this.ctlServer.sendToCliSocket(agentId, { type: 'cli_cancel' });
          return { cancelled: true };
        }
        const ctCs = this.getPrimaryChatSession(agent);
        const cancelled = ctCs?.ccProcess?.state === 'active';
        if (cancelled) {
          ctCs!.ccProcess!.cancel();
        }
        return { cancelled };
      }

      case 'compact': {
        const agentId = params.agentId as string;
        if (!agentId) throw new Error('Missing agentId');
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const cmpCs = this.getPrimaryChatSession(agent);
        if (!cmpCs?.ccProcess || cmpCs.ccProcess.state !== 'active') {
          throw new Error('No active CC process to compact');
        }
        const instructions = params.instructions as string | undefined;
        const compactMsg = instructions ? `/compact ${instructions}` : '/compact';
        cmpCs.ccProcess.sendMessage(createTextMessage(compactMsg));
        return { sent: true };
      }

      case 'set_permissions': {
        const agentId = params.agentId as string;
        const mode = params.mode as string;
        if (!agentId) throw new Error('Missing agentId');
        if (!mode) throw new Error('Missing mode');
        const validModes = ['dangerously-skip', 'acceptEdits', 'default', 'plan'];
        if (!validModes.includes(mode)) {
          throw new Error(`Invalid mode: ${mode}. Valid: ${validModes.join(', ')}`);
        }
        const agent = this.agents.get(agentId);
        if (!agent) throw new Error(`Unknown agent: ${agentId}`);
        const agentState = this.sessionStore.getAgent(agentId);
        const previousMode = agentState.permissionMode || agent.config.defaults.permissionMode;
        this.sessionStore.setPermissionMode(agentId, mode);
        this.killAgentProcess(agentId);
        return { mode, previousMode };
      }

      default:
        throw new Error(`Unknown supervisor action: ${action}`);
    }
  }

  private emitStateChanged(agentId: string, field: string, oldValue: string, newValue: string, source: string): void {
    this.logger.info({ agentId, field, oldValue, newValue, source }, 'Agent state changed');
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.eventBuffer.push({ ts: Date.now(), type: 'system', text: `State changed: ${field} → ${newValue}` });
    }
    if (this.isSupervisorSubscribed(agentId, this.agentPrimarySessionId(agentId))) {
      this.sendToSupervisor({
        type: 'event',
        event: 'state_changed',
        agentId,
        field,
        oldValue,
        newValue,
        source,
      });
    }
  }

  private sendToSupervisor(msg: Record<string, unknown>): void {
    if (this.supervisorWrite) {
      try { this.supervisorWrite(JSON.stringify(msg) + '\n'); } catch {}
    }
  }

  private sendSupervisorRequest(msg: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const requestId = (msg as { requestId?: string }).requestId ?? '';
      const timer = setTimeout(() => {
        this.supervisorPendingRequests.delete(requestId);
        reject(new Error('Supervisor request timed out'));
      }, timeoutMs);
      this.supervisorPendingRequests.set(requestId, { resolve, reject, timer });
      this.sendToSupervisor(msg);
    });
  }

  private destroyEphemeralAgent(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent || !agent.ephemeral) return;

    // Route agent_destroyed to EventRouter → watchers (ralph) + future consumers
    this.eventRouter.routeLifecycle({
      type: 'agent_destroyed', agentId, event: 'agent_destroyed',
      summary: 'Ephemeral agent destroyed',
    });
    // Remove watcher registration (if ralph is destroyed, stop watching its target)
    this.watcherManager.removeWatcher(agentId);
    // Remove all watchers that were watching this agent
    this.watcherManager.removeWatchersForTarget(agentId);
    // Clean up ralph metadata
    this.ralphManager.handleDestroyed(agentId);

    this.killAgentProcess(agentId);
    this.agents.delete(agentId);
    this.logger.info({ agentId }, 'Ephemeral agent destroyed');
    this.sendToSupervisor({ type: 'event', event: 'agent_destroyed', agentId });
    this.pushSupervisorEvent(agentId, `🗑️ Ephemeral agent destroyed`, true, false, 'routine');
  }

  // ── Ralph: spawn completion shepherd ──

  /** Restore persisted ralphs after restart — re-creates ephemeral agents with fresh sessions. */
  private async restoreRalphs(): Promise<void> {
    const persisted = this.ralphManager.loadPersisted();
    if (persisted.length === 0) return;

    this.logger.info({ count: persisted.length }, 'Restoring persisted ralphs');
    for (const pr of persisted) {
      // Check target agent still exists
      if (!this.agents.has(pr.meta.targetAgentId)) {
        this.logger.warn({ ralphId: pr.ralphId, targetAgentId: pr.meta.targetAgentId }, 'Ralph target agent gone — skipping restore');
        this.ralphManager.handleDestroyed(pr.ralphId);
        continue;
      }

      // Calculate remaining timeout
      const elapsed = Date.now() - pr.createdAt;
      const remaining = pr.timeoutMs - elapsed;
      if (remaining <= 0) {
        this.logger.info({ ralphId: pr.ralphId }, 'Ralph expired during downtime — skipping restore');
        this.ralphManager.handleDestroyed(pr.ralphId);
        continue;
      }

      // Re-spawn ralph with the original prompt (will get fresh session history)
      const { ralphId, error } = await this.spawnRalph({
        targetAgentId: pr.meta.targetAgentId,
        prompt: pr.prompt,
        spec: pr.spec,
        invokerAgentId: pr.meta.invokerAgentId,
        invokerChatId: pr.meta.invokerChatId,
        timeoutMs: remaining,
        minTurns: pr.minTurns,
        ralphIdOverride: pr.ralphId,
        restored: true,
      });

      if (error) {
        this.logger.warn({ ralphId: pr.ralphId, error }, 'Failed to restore ralph');
        this.ralphManager.handleDestroyed(pr.ralphId);
      } else {
        this.logger.info({ ralphId }, 'Ralph restored after restart');
      }
    }
  }

  /** Set up config-based persistent tracking: agents with `tracks` field automatically watch their targets. */
  private setupPersistentTracking(): void {
    let count = 0;
    for (const [agentId, agentConfig] of Object.entries(this.config.agents)) {
      if (!agentConfig.tracks?.length) continue;
      for (const targetId of agentConfig.tracks) {
        if (!this.agents.has(targetId)) {
          this.logger.warn({ agentId, targetId }, 'Persistent tracking target not found — skipping');
          continue;
        }
        this.watcherManager.addWatcher({
          watcherId: agentId,
          targetAgentId: targetId,
          includeReply: true,
          notifyTg: true,
          meta: { persistent: true },
        });
        count++;
      }
    }
    if (count > 0) {
      this.logger.info({ count }, 'Persistent tracking set up from config');
    }
  }

  private async spawnRalph(opts: {
    targetAgentId: string;
    prompt: string;
    spec?: string;
    invokerAgentId: string;
    invokerChatId: number;
    timeoutMs?: number;
    minTurns?: number;
    ralphIdOverride?: string;
    restored?: boolean;
  }): Promise<{ ralphId: string; error?: string }> {
    const { targetAgentId, prompt, invokerAgentId, invokerChatId } = opts;
    const targetAgent = this.agents.get(targetAgentId);
    if (!targetAgent) return { ralphId: '', error: `Unknown agent: ${targetAgentId}` };

    const ralphId = opts.ralphIdOverride ?? `ralph-${randomUUID().slice(0, 8)}`;
    if (this.agents.has(ralphId)) return { ralphId: '', error: 'Ralph ID collision — try again' };

    // Gather context — ralph watches the agent, use its primary chat's CC process.
    const proc = this.getPrimaryChatSession(targetAgent)?.ccProcess;
    const status = {
      state: proc?.state ?? 'idle',
      model: targetAgent.model,
      repo: targetAgent.repo,
      cost: this.highSignalDetector.getSessionCost(targetAgentId) ?? 0,
      contextPct: this.highSignalDetector.getContextPercent(targetAgentId),
      sessionId: proc?.sessionId ?? null,
    };

    const recentLog = targetAgent.eventBuffer.query({ limit: 30 });
    const logText = recentLog.lines.map(l => `[${l.type}] ${l.text}`).join('\n');

    let sessionHistory = '';
    if (status.sessionId) {
      const jsonlPath = getSessionJsonlPath(status.sessionId, targetAgent.repo, targetAgent.claudeConfigDir);
      sessionHistory = await extractRecentConversation(jsonlPath, 16, 10000);
    }

    const systemPrompt = buildRalphPrompt({ targetAgentId, prompt, spec: opts.spec, status, recentLog: logText, sessionHistory, restored: opts.restored, minTurns: opts.minTurns });

    // Create ephemeral ralph agent
    const ephemeralConfig: AgentConfig = {
      botToken: '',
      allowedUsers: [],
      defaults: {
        model: 'sonnet',
        repo: targetAgent.repo,
        idleTimeoutMs: 600_000,
        hangTimeoutMs: 300_000,
        permissionMode: 'dangerously-skip',
      },
    };

    const instance: AgentInstance = {
      id: ralphId,
      config: ephemeralConfig,
      tgBot: null,
      ephemeral: true,
      repo: targetAgent.repo,
      model: 'sonnet',
      chatSessions: new Map(),
      pendingPermissions: new Map(),
      pendingExecApprovals: new Map(),
      lastTgChatId: null,
      lastTgUserId: null,
      destroyTimer: null,
      eventBuffer: new EventBuffer(),
      awaitingAskCleanup: false,
      muteOutput: false,
      authFlowInProgress: false,
      lastSendData: null,
      claudeConfigDir: undefined,
      pendingCliTmuxAgent: null,
    };

    // Auto-destroy timeout (default 2 hours)
    const timeoutMs = opts.timeoutMs ?? 120 * 60_000;
    instance.destroyTimer = setTimeout(() => {
      // Guard: skip if ralph was already destroyed (e.g. via ralph_done)
      if (!this.agents.has(ralphId)) return;
      this.logger.info({ agentId: ralphId, timeoutMs }, 'Ralph timeout — auto-destroying');
      // Notify user
      const invokerAgent = this.agents.get(invokerAgentId);
      if (invokerAgent?.tgBot) {
        invokerAgent.tgBot.sendText(invokerChatId,
          `<blockquote>⏰ Ralph (<code>${ralphId}</code>) timed out after ${Math.round(timeoutMs / 60_000)}min watching <code>${targetAgentId}</code></blockquote>`, 'HTML')
          .catch(() => {});
      }
      this.destroyEphemeralAgent(ralphId);
    }, timeoutMs);

    this.agents.set(ralphId, instance);

    // Register ralph: watcher subscription + supervisor tracking + TG notification
    this.ralphManager.register(ralphId, { targetAgentId, invokerChatId, invokerAgentId }, { prompt, spec: opts.spec, timeoutMs, minTurns: opts.minTurns });

    // Send initial prompt
    this.sendToCC(ralphId, { text: systemPrompt }, { spawnSource: 'supervisor' });

    return { ralphId };
  }

  // ── Shutdown ──

  async stop(): Promise<void> {
    this.logger.info('Stopping bridge');

    // Notify supervisor chat only before shutting down
    if (this.nativeSupervisorId) {
      const supAgent = this.agents.get(this.nativeSupervisorId);
      const chatId = supAgent ? this.getAgentChatId(supAgent) : null;
      if (chatId && supAgent?.tgBot) {
        await supAgent.tgBot.sendText(chatId, '<blockquote>🔄 Restarting… Session will resume on next message.</blockquote>', 'HTML', true)
          .catch(err => this.logger.warn({ err }, 'Failed to send shutdown notification'));
      }
    }

    for (const agentId of [...this.agents.keys()]) {
      await this.stopAgent(agentId);
    }

    this.scheduler.stopAll();
    this.processRegistry.clear();
    this.highSignalDetector.destroy();
    this.eventDedup.destroy();
    this.ralphManager.destroy();
    this.watcherManager.destroy();
    this.supervisorManager?.destroy();
    this.eventRouter.destroy();
    this.mcpServer.closeAll();
    this.ctlServer.closeAll();
    this.removeAllListeners();
    this.logger.info('Bridge stopped');
  }
}

// ── AskUserQuestion helpers ──

/** Extract display label from an option (CC sends objects; plain strings also accepted). */
function getOptLabel(opt: AskOption | string): string {
  return typeof opt === 'string' ? opt : opt.label;
}

/** Build Telegram message text + inline keyboard for AskUserQuestion. */
function buildAskUi(
  requestId: string,
  questions: AskQuestion[],
  answers: Record<string, string[]>,
): { text: string; keyboard: InlineKeyboard } {
  const lines: string[] = [];
  const kb = new InlineKeyboard();

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi];
    const multi = !!q.multiSelect;
    const header = multi ? ` <i>(select multiple)</i>` : '';
    lines.push(`<b>${escapeHtml(q.question)}</b>${header}`);

    const selected = answers[String(qi)] ?? [];
    for (let oi = 0; oi < (q.options ?? []).length; oi++) {
      const optLabel = getOptLabel(q.options![oi]);
      const isSelected = selected.includes(optLabel);
      const label = multi ? (isSelected ? `✓ ${optLabel}` : `   ${optLabel}`) : optLabel;
      const action = multi ? 'ask_toggle' : 'ask_pick';
      kb.text(label, `${action}:${requestId}:${qi}:${oi}`).row();
    }
    kb.text('✏️ Other…', `ask_other:${requestId}:${qi}`).row();
    if (multi) kb.text('✅ Submit', `ask_submit:${requestId}:${qi}`).row();

    if (qi < questions.length - 1) lines.push('');
  }

  const body = lines.join('\n');
  return { text: `🤖 ${body}`, keyboard: kb };
}

/** Build updatedInput answers map from selected options. */
function buildAskAnswers(
  questions: AskQuestion[],
  answers: Record<string, string[]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (let qi = 0; qi < questions.length; qi++) {
    const sel = answers[String(qi)];
    if (sel?.length) result[String(qi)] = sel.join('\n');
  }
  return result;
}

/** Build the user-turn text that injects AskUserQuestion answers. */
function buildAskAnswerText(
  questions: AskQuestion[],
  answers: Record<string, string[]>,
): string {
  const builtAnswers = buildAskAnswers(questions, answers);
  const answerParts = questions
    .map((q, i) => {
      const ans = builtAnswers[String(i)];
      return ans ? `"${q.question}" → "${ans}"` : null;
    })
    .filter((p): p is string => p !== null);
  return answerParts.length > 0
    ? `User has answered your questions: ${answerParts.join(', ')}. You can now continue with the user's answers in mind.`
    : 'User declined to answer.';
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

function formatTimeUntil(date: Date): string {
  const diffMs = date.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `in ${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `in ${days}d ${hours % 24}h`;
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

