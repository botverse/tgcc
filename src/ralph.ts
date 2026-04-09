// ── Ralph Manager ──
//
// Ralph lifecycle management: prompt building, metadata tracking, TG notifications.
// Consumes WatcherManager for event delivery, SupervisorManager for tracking.
// Bridge still owns agent instance creation; RalphManager owns ralph-specific logic.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WatcherManager } from './watcher.js';
import type pino from 'pino';

// ── Types ──

export interface RalphMeta {
  targetAgentId: string;
  invokerChatId: number;
  invokerAgentId: string;
}

export interface PersistedRalph {
  ralphId: string;
  meta: RalphMeta;
  prompt: string;
  createdAt: number;
  timeoutMs: number;
}

export interface RalphDeps {
  /** Register a watcher subscription. */
  watcherManager: WatcherManager;
  /** Track ralph in supervisor TG. */
  supervisorTrack: (agentId: string) => void;
  /** Push a supervisor event. */
  pushSupervisorEvent: (agentId: string, text: string) => void;
  /** Send TG text via an agent's bot. */
  sendTgText: (agentId: string, chatId: number, text: string, parseMode: string) => Promise<void>;
}

export interface RalphStatus {
  state: string;
  model: string;
  repo: string;
  cost: number;
  contextPct: number | null;
  sessionId: string | null;
}

// ── RalphManager ──

export class RalphManager {
  private metas = new Map<string, RalphMeta>();
  private persisted = new Map<string, PersistedRalph>();
  private deps: RalphDeps;
  private logger: pino.Logger;
  private persistPath: string | null;

  constructor(deps: RalphDeps, logger: pino.Logger, persistPath?: string) {
    this.deps = deps;
    this.logger = logger;
    this.persistPath = persistPath ?? null;
  }

  /** Register a ralph instance with its metadata. Adds watcher + supervisor tracking. */
  register(ralphId: string, meta: RalphMeta, opts?: { prompt?: string; timeoutMs?: number }): void {
    this.metas.set(ralphId, meta);
    this.deps.watcherManager.addWatcher({
      watcherId: ralphId,
      targetAgentId: meta.targetAgentId,
      includeReply: true,
      meta: { isRalph: true },
    });
    this.deps.supervisorTrack(ralphId);
    // Persist for restart survival
    this.persisted.set(ralphId, {
      ralphId,
      meta,
      prompt: opts?.prompt ?? 'Ensure the worker completes its current task successfully.',
      createdAt: Date.now(),
      timeoutMs: opts?.timeoutMs ?? 30 * 60_000,
    });
    this.save();
    this.logger.info({ ralphId, targetAgentId: meta.targetAgentId }, 'Ralph registered');
    this.deps.pushSupervisorEvent(ralphId, `🐕 Ralph spawned, watching ${meta.targetAgentId}`);
  }

  /** Handle ralph_done: notify user on TG, clean up watcher, push supervisor event.
   *  Returns an error string if the agent is not a ralph. */
  done(ralphId: string, summary: string, success: boolean): { error?: string } {
    const meta = this.metas.get(ralphId);
    if (!meta) return { error: 'Only Ralph agents can call ralph_done' };

    // Remove watcher subscription
    this.deps.watcherManager.removeWatcher(ralphId);

    // Notify user on TG
    const emoji = success ? '✅' : '⚠️';
    const text = `<blockquote>${emoji} <b>Ralph report</b> (watching <code>${escapeHtml(meta.targetAgentId)}</code>):\n${escapeHtml(summary)}</blockquote>`;
    this.deps.sendTgText(meta.invokerAgentId, meta.invokerChatId, text, 'HTML')
      .catch(err => this.logger.warn({ err }, 'Failed to send ralph_done TG notification'));

    this.deps.pushSupervisorEvent(ralphId, `${emoji} Ralph done: ${summary.slice(0, 100)}`);
    this.metas.delete(ralphId);
    this.persisted.delete(ralphId);
    this.save();
    return {};
  }

  /** Handle send_message routing for ralph agents (they have no TG chat of their own).
   *  Returns null if this is not a ralph agent. */
  async routeSendMessage(ralphId: string, messageText: string): Promise<{ success: boolean; error?: string } | null> {
    const meta = this.metas.get(ralphId);
    if (!meta) return null;

    try {
      const label = `🐕 <b>Ralph</b> (<code>${escapeHtml(ralphId)}</code>):`;
      await this.deps.sendTgText(meta.invokerAgentId, meta.invokerChatId, `${label}\n${escapeHtml(messageText)}`, 'HTML');
      return { success: true };
    } catch {
      return { success: false, error: 'Invoker agent has no TG chat' };
    }
  }

  /** Check if an agent is a ralph instance. */
  isRalph(agentId: string): boolean {
    return this.metas.has(agentId);
  }

  /** Get ralph metadata for an agent. */
  getMeta(agentId: string): RalphMeta | undefined {
    return this.metas.get(agentId);
  }

  /** Clean up ralph metadata when an agent is destroyed. */
  handleDestroyed(agentId: string): void {
    this.metas.delete(agentId);
    this.persisted.delete(agentId);
    this.save();
  }

  /** Number of active ralph instances. */
  get size(): number {
    return this.metas.size;
  }

  /** Load persisted ralphs from disk (call at startup before restoring). */
  loadPersisted(): PersistedRalph[] {
    if (!this.persistPath) return [];
    try {
      const data = JSON.parse(readFileSync(this.persistPath, 'utf-8')) as PersistedRalph[];
      // Filter out timed-out ralphs
      const now = Date.now();
      return data.filter(r => now - r.createdAt < r.timeoutMs);
    } catch {
      return [];
    }
  }

  /** Register metadata for a restored ralph (no watcher/supervisor — Bridge handles that during restore). */
  registerMeta(ralphId: string, meta: RalphMeta): void {
    this.metas.set(ralphId, meta);
  }

  private save(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify([...this.persisted.values()], null, 2));
    } catch (err) {
      this.logger.warn({ err }, 'Failed to persist ralph state');
    }
  }

  /** Clean up all ralph state. */
  destroy(): void {
    this.metas.clear();
    this.persisted.clear();
  }
}

// ── Ralph Prompt Builder ──

export function buildRalphPrompt(opts: {
  targetAgentId: string;
  prompt: string;
  status: RalphStatus;
  recentLog: string;
  sessionHistory: string;
  restored?: boolean;
}): string {
  const isRestore = opts.restored ?? false;
  const idleNote = opts.status.state === 'idle' || opts.status.state === undefined
    ? isRestore
      ? '\n⚠️ The worker is currently IDLE after a TGCC restart. Wait for it to start working — events will arrive automatically. Do NOT escalate just because the session history is empty.'
      : '\n⚠️ The worker is currently IDLE. You should send it a message to start/continue working.'
    : '';
  return `You are Ralph, a completion shepherd. Your job is to ensure agent "${opts.targetAgentId}" finishes its task. You are a MANAGER, not a worker.

CRITICAL RULES:
- You NEVER write code, run tests, edit files, or do the work yourself
- You ONLY monitor, nudge, and verify that the WORKER does everything
- If something needs building or testing, tell the worker to do it via tgcc_send
- The worker must produce working, tested code — don't let it cut corners
- Things being built HAVE to work. Ensure the worker tests and verifies.

YOUR GOAL:
${opts.prompt}

TOOLS:
- tgcc_send(agentId="${opts.targetAgentId}", text="...") — send a message to nudge/redirect the worker
- tgcc_log(agentId="${opts.targetAgentId}") — read the worker's recent event log
- tgcc_status(agentId="${opts.targetAgentId}") — check worker state, context%, cost
- tgcc_session(agentId="${opts.targetAgentId}", action="compact") — compact if context pressure
- tgcc_session(agentId="${opts.targetAgentId}", action="continue") — respawn if process exited
- tgcc_session(agentId="${opts.targetAgentId}", action="new", prompt="...") — fresh session if truly stuck
- ralph_done(summary="...", success=true/false) — declare task complete, self-destruct. ALWAYS use this when done.
- send_message(text="...") — message the user on Telegram (for escalation only)

EVENTS YOU RECEIVE AUTOMATICALLY:
- [turn_complete] — worker finished a turn (with reply snippet)
- [build_result] — test/build pass or fail
- [failure_loop] — 3+ consecutive tool failures
- [stuck] — no output for 5 minutes
- [context_pressure] — context usage thresholds (50%, 75%, 90%)
- [task_milestone] — TodoWrite progress updates
- [git_commit] — commits made
- [budget_alert] — cost thresholds
- [process_exited] — worker CC process exited

WORKFLOW:
1. Read the session history below carefully. The LAST user message is the current task.
   Previous tasks in the history may already be completed — focus on what's PENDING.
2. If the worker is idle or process exited, send it a message to start/continue the current task.
3. Wait for events — you'll be notified automatically, no need to poll.
4. After each event, check logs to understand what happened. Decide: let it work, or intervene.
5. When the task is DONE, TESTED, and WORKING, call ralph_done(summary, success=true).
6. If stuck after 3 nudges with no progress, message the user and ralph_done(success=false).

CRITICAL — DO NOT:
- Conclude the task is done just because previous tasks in the history were completed.
- Call ralph_done without verifying the CURRENT goal (stated above) has been achieved.
- Assume the worker has finished unless you see concrete evidence (build passed, tests passed, commit made).

RULES:
- Be patient. Let the worker work. Only intervene if it's stuck or off-track.
- Check logs after each turn notification to understand what happened.
- If context exceeds 85%, compact the session.
- If the worker has been idle for more than 2 minutes after a turn, nudge it.
- If you've nudged 3 times with no progress, escalate to the user via send_message, then ralph_done(success=false).
- Keep your own messages minimal. You are a shepherd, not a participant.
- ALWAYS call ralph_done when finished. Never just stop.${idleNote}

== CURRENT TARGET STATUS ==
State: ${opts.status.state ?? 'idle'}
Model: ${opts.status.model}
Repo: ${opts.status.repo}
Session cost: $${opts.status.cost.toFixed(4)}
Context used: ${opts.status.contextPct ?? 'unknown'}%
Session ID: ${opts.status.sessionId ?? 'none'}

== RECENT EVENT LOG ==
${opts.recentLog || '(no recent events)'}

== SESSION HISTORY ==
${opts.sessionHistory || '(no session history available)'}${isRestore && !opts.sessionHistory ? `

== RESTORE NOTE ==
You were restored after a TGCC restart. The worker's session history is unavailable because it has not started a new session yet. This is NORMAL — do NOT escalate or call ralph_done. Wait patiently for events. The worker will resume automatically and you will start receiving turn_complete and other events. Your original goal (above) is still valid.` : ''}`;
}

// ── Utility ──

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
