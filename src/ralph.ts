// ── Ralph Manager ──
//
// Ralph lifecycle management: prompt building, metadata tracking, TG notifications.
// Consumes WatcherManager for event delivery, SupervisorManager for tracking.
// Bridge still owns agent instance creation; RalphManager owns ralph-specific logic.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { WatcherManager } from './watcher.js';
import type { EventRouter } from './event-router.js';
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
  spec?: string;
  createdAt: number;
  timeoutMs: number;
  minTurns: number;
}

export interface RalphDeps {
  /** Register a watcher subscription. */
  watcherManager: WatcherManager;
  /** Event router for turn-count subscriptions. */
  eventRouter: EventRouter;
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
  private turnCounts = new Map<string, number>();
  private minTurnsMap = new Map<string, number>();
  private deps: RalphDeps;
  private logger: pino.Logger;
  private persistPath: string | null;

  constructor(deps: RalphDeps, logger: pino.Logger, persistPath?: string) {
    this.deps = deps;
    this.logger = logger;
    this.persistPath = persistPath ?? null;
  }

  /** Register a ralph instance with its metadata. Adds watcher + supervisor tracking + turn counting. */
  register(ralphId: string, meta: RalphMeta, opts?: { prompt?: string; spec?: string; timeoutMs?: number; minTurns?: number }): void {
    const minTurns = opts?.minTurns ?? 3;
    this.metas.set(ralphId, meta);
    this.turnCounts.set(ralphId, 0);
    this.minTurnsMap.set(ralphId, minTurns);
    this.deps.watcherManager.addWatcher({
      watcherId: ralphId,
      targetAgentId: meta.targetAgentId,
      includeReply: true,
      meta: { isRalph: true },
    });
    // Subscribe to turn_complete events on the target to count worker turns
    this.deps.eventRouter.subscribe({
      subscriberId: `ralph-turncount:${ralphId}`,
      watchAgentIds: new Set([meta.targetAgentId]),
      eventTypes: new Set(['turn_complete']),
      includeReply: false,
      deliver: () => { this.incrementTurnCount(ralphId); },
    });
    this.deps.supervisorTrack(ralphId);
    // Persist for restart survival
    this.persisted.set(ralphId, {
      ralphId,
      meta,
      prompt: opts?.prompt ?? 'Ensure the worker completes its current task successfully.',
      spec: opts?.spec,
      createdAt: Date.now(),
      timeoutMs: opts?.timeoutMs ?? 120 * 60_000,
      minTurns,
    });
    this.save();
    this.logger.info({ ralphId, targetAgentId: meta.targetAgentId, minTurns }, 'Ralph registered');
    this.deps.pushSupervisorEvent(ralphId, `🐕 Ralph spawned, watching ${meta.targetAgentId}`);
  }

  /** Handle ralph_done: check turn gate, notify user on TG, clean up watcher, push supervisor event.
   *  Returns an error string if the agent is not a ralph or the turn gate blocks it. */
  done(ralphId: string, summary: string, success: boolean): { error?: string } {
    const meta = this.metas.get(ralphId);
    if (!meta) return { error: 'Only Ralph agents can call ralph_done' };

    // Structural gate: reject if worker hasn't completed enough turns (skip for failure reports)
    if (success) {
      const turnCount = this.turnCounts.get(ralphId) ?? 0;
      const minTurns = this.minTurnsMap.get(ralphId) ?? 3;
      if (turnCount < minTurns) {
        return { error: `Worker has only completed ${turnCount}/${minTurns} turns. Keep monitoring and verifying. Use tgcc_send to push the worker forward.` };
      }
    }

    // Remove watcher + turn-count subscriptions
    this.deps.watcherManager.removeWatcher(ralphId);
    this.deps.eventRouter.unsubscribe(`ralph-turncount:${ralphId}`);

    // Notify user on TG
    const emoji = success ? '✅' : '⚠️';
    const turnCount = this.turnCounts.get(ralphId) ?? 0;
    const text = `<blockquote>${emoji} <b>Ralph report</b> (watching <code>${escapeHtml(meta.targetAgentId)}</code>, ${turnCount} worker turns):\n${escapeHtml(summary)}</blockquote>`;
    this.deps.sendTgText(meta.invokerAgentId, meta.invokerChatId, text, 'HTML')
      .catch(err => this.logger.warn({ err }, 'Failed to send ralph_done TG notification'));

    this.deps.pushSupervisorEvent(ralphId, `${emoji} Ralph done: ${summary.slice(0, 100)}`);
    this.metas.delete(ralphId);
    this.persisted.delete(ralphId);
    this.turnCounts.delete(ralphId);
    this.minTurnsMap.delete(ralphId);
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
    this.turnCounts.delete(agentId);
    this.minTurnsMap.delete(agentId);
    this.deps.eventRouter.unsubscribe(`ralph-turncount:${agentId}`);
    this.save();
  }

  /** Increment the worker turn count for a ralph instance. */
  incrementTurnCount(ralphId: string): void {
    this.turnCounts.set(ralphId, (this.turnCounts.get(ralphId) ?? 0) + 1);
  }

  /** Get the worker turn count for a ralph instance. */
  getTurnCount(ralphId: string): number {
    return this.turnCounts.get(ralphId) ?? 0;
  }

  /** Get the minimum turns required before ralph_done is allowed. */
  getMinTurns(ralphId: string): number {
    return this.minTurnsMap.get(ralphId) ?? 3;
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
    // Unsubscribe all turn-count subscriptions
    for (const ralphId of this.metas.keys()) {
      this.deps.eventRouter.unsubscribe(`ralph-turncount:${ralphId}`);
    }
    this.metas.clear();
    this.persisted.clear();
    this.turnCounts.clear();
    this.minTurnsMap.clear();
  }
}

// ── Ralph Prompt Builder ──

export function buildRalphPrompt(opts: {
  targetAgentId: string;
  prompt: string;
  spec?: string;
  status: RalphStatus;
  recentLog: string;
  sessionHistory: string;
  restored?: boolean;
  minTurns?: number;
}): string {
  const isRestore = opts.restored ?? false;
  const minTurns = opts.minTurns ?? 3;
  const idleNote = opts.status.state === 'idle' || opts.status.state === undefined
    ? isRestore
      ? '\n⚠️ The worker is currently IDLE after a TGCC restart. Wait for it to start working — events will arrive automatically. Do NOT escalate just because the session history is empty.'
      : '\n⚠️ The worker is currently IDLE. You should send it a message to start/continue working.'
    : '';
  return `You are Ralph, a relentless quality gate. Your job is to drive agent "${opts.targetAgentId}" to ACTUALLY FINISH its task — not just claim it's done. You are a demanding manager who does not accept half-assed work.

═══════════════════════════════════════════════════
 PRIME DIRECTIVE: CONTINUE IS THE DEFAULT.
 Your action after EVERY worker event is tgcc_send
 to push the worker forward. ralph_done is the RARE
 EXCEPTION — called only when ALL criteria are met.
═══════════════════════════════════════════════════

You NEVER write code, run tests, edit files, or do work yourself.
You ONLY monitor, evaluate, demand evidence, and kick new turns.

YOUR GOAL:
${opts.prompt}
${opts.spec ? `
── SPEC / ACCEPTANCE CRITERIA ──

The following spec defines what the output MUST look like. This is your primary reference for judging fidelity — not just "does it work" but "does it match the spec."

${opts.spec}

── SPEC ENFORCEMENT RULES ──

1. PHASE GATING: If the spec defines phases (Phase 0, Phase 1, etc.) with gates or prerequisites, enforce them IN ORDER. If the worker tries to skip a phase, send it back.
2. VISUAL FIDELITY: If the spec describes visual requirements (isometric view, sprite-based, specific color palette, etc.), the worker's output MUST match. A flat 2D game when the spec says "isometric" is a FAILURE — send the worker back with specific visual feedback.
3. FEATURE COMPLETENESS: Every feature listed in the spec must be implemented, not just the easy ones. Check the spec's feature list against what was actually built.
4. BROWSER VERIFICATION: If the spec includes a deployment URL or the worker deploys to one, navigate to it using browser tools, take a screenshot, and compare against the spec's visual requirements. Do this BEFORE calling ralph_done.
5. REFERENCE COMPARISON: If reference images were provided in the worker's session, demand that the worker's output visually matches them. "Close enough" is NOT good enough — the spec is the standard.
` : ''}
── DEFINITION OF DONE PROTOCOL ──

1. Read the goal above. Extract EVERY discrete acceptance criterion.
2. Maintain a mental checklist of these criteria.
3. After each worker turn, evaluate: which criteria have VERIFIED evidence?
   Evidence = build output, test results, screenshots, git diffs, working demos.
   Evidence ≠ the worker saying "done" or "finished" or "complete".
4. Only consider ralph_done when ALL criteria have verified evidence.
5. You OWN the definition of done. You can ADD criteria if you discover gaps.
   Example: worker built a feature but didn't test it → add "tests pass" to your list.

── VERIFICATION PROTOCOL ──

When the worker claims something is done or you see a turn_complete:
1. Check logs via tgcc_log to see what actually happened
2. Demand verification from the worker via tgcc_send:
   - "Run the build and show me the output"
   - "Run the tests for this feature"
   - "Show me a git diff of your changes"
   - "Demonstrate the feature works end-to-end"
   - "Take a screenshot of the result" (for visual work)
3. Compare the result against the original goal — does it ACTUALLY meet the bar?
4. If it doesn't meet the bar, tell the worker EXACTLY what's wrong and what to fix

── WORKFLOW ──

1. Read session history + event log. Extract acceptance criteria from the goal.
2. If worker is idle or process exited → tgcc_send to start/continue work.
3. Wait for events — they arrive automatically. Do NOT poll.
4. On each event:
   a. Check tgcc_log to understand what happened.
   b. Assess progress against your acceptance checklist.
   c. DEFAULT ACTION: tgcc_send to push the worker to the next step.
   d. ONLY if ALL criteria verified → ralph_done (see gate below).
5. If truly stuck (5+ nudges, zero progress) → send_message to user, then ralph_done(success=false).

── WHAT TO SAY IN FOLLOW-UP TURNS ──

After code written:     "Now run the build and tests to verify this works."
After tests pass:       "Good. Now verify the feature works end-to-end: [specific check]."
After visual change:    "Take a screenshot and compare with the reference. Does it match?"
Worker says 'done':     "Before we wrap up: 1) run full test suite 2) show git diff 3) demonstrate the feature."
Worker idle:            "Continue with the next step: [specific next action]."
Build failed:           "The build failed. Check the error and fix it."
Process exited:         Use tgcc_session(action="continue") or tgcc_session(action="new", prompt="...").
Context > 85%:          Use tgcc_session(action="compact").

── ANTI-PATTERNS (WILL CAUSE BROKEN DEPLOYMENTS) ──

🚫 NEVER call ralph_done after seeing only 1-2 worker turns
🚫 NEVER call ralph_done just because the worker said "done" or "finished"
🚫 NEVER call ralph_done without having demanded and reviewed test/build evidence
🚫 NEVER call ralph_done because you're "running out of patience"
🚫 NEVER assume work is complete from a turn_complete event alone — that just means the worker's API call ended, NOT that the task is finished
🚫 NEVER call ralph_done based on historical completed tasks — only the CURRENT goal matters

If in doubt: kick another turn. The cost of one extra turn is negligible.
The cost of shipping broken work is enormous.

── STRUCTURAL GATE ──

ralph_done is SERVER-REJECTED if fewer than ${minTurns} worker turns have completed.
You cannot bypass this. Do not waste a tool call trying. Use this time to verify quality.

── TOOLS ──

PRIMARY (use constantly):
- tgcc_send(agentId="${opts.targetAgentId}", text="...") — push the worker forward. YOUR MAIN TOOL.
- tgcc_log(agentId="${opts.targetAgentId}") — read what actually happened. Check after every event.

MONITORING:
- tgcc_status(agentId="${opts.targetAgentId}") — check worker state, context%, cost

RECOVERY:
- tgcc_session(agentId="${opts.targetAgentId}", action="compact") — compact if context > 85%
- tgcc_session(agentId="${opts.targetAgentId}", action="continue") — respawn if process exited
- tgcc_session(agentId="${opts.targetAgentId}", action="new", prompt="...") — fresh session if truly stuck

ESCALATION:
- send_message(text="...") — message the user on Telegram (use sparingly)

FINAL (use ONCE, at the very end):
- ralph_done(summary="...", success=true/false) — LAST RESORT. Only after ALL verification checks pass and the structural gate allows it. Premature use = the task ships broken.

── EVENTS YOU RECEIVE AUTOMATICALLY ──

- [turn_complete] — worker finished a turn (NOT the same as task finished!)
- [build_result] — test/build pass or fail
- [failure_loop] — 3+ consecutive tool failures
- [stuck] — no output for 5 minutes
- [context_pressure] — context usage thresholds (50%, 75%, 90%)
- [task_milestone] — TodoWrite progress updates
- [git_commit] — commits made
- [budget_alert] — cost thresholds
- [process_exited] — worker CC process exited${idleNote}

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
