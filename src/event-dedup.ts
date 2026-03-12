// ── Event Dedup / Noise Filter ──
//
// Sits between HighSignalDetector.emit() and the supervisor routing callbacks.
// Filters out noisy / redundant events before they wake the supervisor.

import type { HighSignalEvent } from './high-signal.js';

export interface EventDedupOptions {
  /** Window (ms) for batching git commits. Default 30 000. */
  gitBatchWindowMs?: number;
}

interface AgentDedupState {
  /** Was the last build_result a pass? Used to suppress consecutive passes. */
  lastBuildPassed: boolean | null;

  /** Git commit batch state: commits collected during the current window. */
  gitBatchTimer: ReturnType<typeof setTimeout> | null;
  gitBatchedCommits: string[];

  /** Per-turn subagent spawn: only forward the first. */
  lastSubagentTurn: number;  // spawnCountThisTurn at which we last forwarded
}

type FlushFn = (event: HighSignalEvent) => void;

export class EventDedup {
  private states = new Map<string, AgentDedupState>();
  private gitBatchWindowMs: number;
  private flushFn: FlushFn;

  constructor(flushFn: FlushFn, options?: EventDedupOptions) {
    this.flushFn = flushFn;
    this.gitBatchWindowMs = options?.gitBatchWindowMs ?? 30_000;
  }

  /**
   * Returns true if the event should be forwarded to the supervisor.
   * Some events are not forwarded immediately but batched (git_commit).
   * The caller should only forward the event if this returns true.
   */
  shouldForward(event: HighSignalEvent): boolean {
    const state = this.getState(event.agentId);

    switch (event.event) {
      case 'build_result':
        return this.dedupBuild(state, event);

      case 'git_commit':
        this.batchGitCommit(state, event);
        return false; // never forward immediately — batched

      case 'subagent_spawn':
        return this.dedupSubagentSpawn(state, event);

      case 'context_pressure':
        // Already deduped by contextThresholdsHit set in HighSignalDetector.
        // Each threshold (50/75/90) fires exactly once per session. No extra dedup needed.
        return true;

      default:
        // All other events (failure_loop, stuck, task_milestone, budget_alert) pass through.
        return true;
    }
  }

  /**
   * Clean up state for an agent (on process exit).
   */
  cleanup(agentId: string): void {
    const state = this.states.get(agentId);
    if (state?.gitBatchTimer) {
      clearTimeout(state.gitBatchTimer);
      // Flush any pending commits before cleanup
      if (state.gitBatchedCommits.length > 0) {
        this.flushGitBatch(agentId, state);
      }
    }
    this.states.delete(agentId);
  }

  /**
   * Destroy all state.
   */
  destroy(): void {
    for (const [agentId] of this.states) {
      this.cleanup(agentId);
    }
  }

  // ── Private: State management ──

  private getState(agentId: string): AgentDedupState {
    let state = this.states.get(agentId);
    if (!state) {
      state = {
        lastBuildPassed: null,
        gitBatchTimer: null,
        gitBatchedCommits: [],
        lastSubagentTurn: 0,
      };
      this.states.set(agentId, state);
    }
    return state;
  }

  // ── Private: Dedup logic ──

  /**
   * Build results: suppress consecutive passes (only first pass after a failure).
   * Failures always forward.
   */
  private dedupBuild(state: AgentDedupState, event: HighSignalEvent): boolean {
    const passed = event.passed === true;

    if (!passed) {
      // Failure: always forward, update state
      state.lastBuildPassed = false;
      return true;
    }

    // Pass: only forward if previous was a failure (or first build)
    if (state.lastBuildPassed === true) {
      // Consecutive pass — suppress
      return false;
    }

    state.lastBuildPassed = true;
    return true;
  }

  /**
   * Git commits: batch within a window, then send one summary.
   */
  private batchGitCommit(state: AgentDedupState, event: HighSignalEvent): void {
    const message = String(event.message ?? '');
    state.gitBatchedCommits.push(message);

    // Start or extend the batch window
    if (!state.gitBatchTimer) {
      state.gitBatchTimer = setTimeout(() => {
        this.flushGitBatch(event.agentId, state);
      }, this.gitBatchWindowMs);
    }
  }

  private flushGitBatch(agentId: string, state: AgentDedupState): void {
    if (state.gitBatchTimer) {
      clearTimeout(state.gitBatchTimer);
      state.gitBatchTimer = null;
    }

    const commits = state.gitBatchedCommits.splice(0);
    if (commits.length === 0) return;

    if (commits.length === 1) {
      // Single commit — send as normal git_commit event
      this.flushFn({
        type: 'event',
        event: 'git_commit',
        agentId,
        message: commits[0],
        emoji: '\uD83D\uDCDD',
        summary: `Committed: "${commits[0]}"`,
      });
    } else {
      // Multiple commits — send a batch summary
      const summary = commits.length <= 3
        ? commits.map(c => `"${c}"`).join(', ')
        : `${commits.length} commits (latest: "${commits[commits.length - 1]}")`;

      this.flushFn({
        type: 'event',
        event: 'git_commit',
        agentId,
        message: summary,
        count: commits.length,
        emoji: '\uD83D\uDCDD',
        summary: `Committed: ${summary}`,
      });
    }
  }

  /**
   * Sub-agent spawns: only forward the first per turn.
   * Uses spawnCountThisTurn from the event — count === 1 means first.
   */
  private dedupSubagentSpawn(_state: AgentDedupState, event: HighSignalEvent): boolean {
    const count = typeof event.count === 'number' ? event.count : 1;
    // Only forward the first spawn per turn
    return count === 1;
  }
}
