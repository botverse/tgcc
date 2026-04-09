// ── Supervisor Manager ──
//
// Owns the native supervisor's worker tracking, heartbeat, and direct event delivery.
// Extracted from Bridge to make supervision a composable module.

import type pino from 'pino';
import { wrapSystemReminder } from './cc-tags.js';

// ── Types ──

export interface SupervisorDeps {
  /** Send text into a CC process stdin. */
  sendToCC: (supervisorId: string, text: string) => void;
  /** Set muteOutput flag on the supervisor agent. */
  setMuteOutput: (supervisorId: string, mute: boolean) => void;
  /** Get supervisor CC process state ('idle' | 'running' | etc). */
  getSupervisorState: () => string | undefined;
  /** Send a TG blockquote to the supervisor's chat (flushes accumulator first). */
  sendTgBlockquote: (text: string) => Promise<void>;
  /** Get worker status for heartbeat. */
  getWorkerStatus: (agentId: string) => {
    state: string;
    cost: number;
    contextPct: number | null;
    lastActivity: string | null;
  };
}

// ── SupervisorManager ──

export class SupervisorManager {
  private supervisorId: string;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 0;
  private deps: SupervisorDeps;
  private logger: pino.Logger;

  /** Workers whose high-signal events are forwarded to the supervisor's TG chat in real time. */
  readonly trackedWorkers = new Set<string>();

  constructor(supervisorId: string, deps: SupervisorDeps, logger: pino.Logger) {
    this.supervisorId = supervisorId;
    this.deps = deps;
    this.logger = logger;
  }

  /** Send an event directly to the supervisor CC process (and optionally to TG).
   *  @param notifyTg — whether TG notification is desired at all (false suppresses completely)
   *  @param forceTg — bypass tracking check (e.g. for explicit notify_parent calls) */
  pushEvent(sourceAgentId: string, text: string, notifyTg = true, forceTg = false): void {
    if (sourceAgentId === this.supervisorId) return;
    const line = `🤖 [${sourceAgentId}] ${text}`;

    // Send directly to supervisor CC stdin
    this.deps.setMuteOutput(this.supervisorId, true);
    this.deps.sendToCC(this.supervisorId, wrapSystemReminder(line));

    // TG forwarding for tracked workers
    if (!notifyTg || (!forceTg && !this.trackedWorkers.has(sourceAgentId))) return;
    this.deps.sendTgBlockquote(line).catch(err =>
      this.logger.warn({ err }, 'Failed to push worker event to supervisor TG'),
    );
  }

  /** Track a worker for real-time TG forwarding. */
  track(agentId: string): void {
    this.trackedWorkers.add(agentId);
  }

  /** Untrack a worker. Returns true if it was tracked. */
  untrack(agentId: string): boolean {
    return this.trackedWorkers.delete(agentId);
  }

  /** Check if a worker is tracked. */
  isTracked(agentId: string): boolean {
    return this.trackedWorkers.has(agentId);
  }

  /** Clear all tracked workers. */
  clearTracked(): void {
    this.trackedWorkers.clear();
  }

  /** Start or restart the supervisor heartbeat timer. */
  startHeartbeat(intervalMs: number): void {
    this.stopHeartbeat();
    if (intervalMs <= 0) return;
    this.heartbeatIntervalMs = intervalMs;
    this.heartbeatTimer = setInterval(() => this.heartbeatTick(), intervalMs);
    this.logger.info({ intervalMs }, 'Supervisor heartbeat started');
  }

  /** Stop the supervisor heartbeat timer. */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.heartbeatIntervalMs = 0;
      this.logger.info('Supervisor heartbeat stopped');
    }
  }

  /** Get current heartbeat interval. */
  getHeartbeatInterval(): number {
    return this.heartbeatIntervalMs;
  }

  /** Clean up timers. */
  destroy(): void {
    this.stopHeartbeat();
    this.trackedWorkers.clear();
  }

  private heartbeatTick(): void {
    if (this.trackedWorkers.size === 0) return;
    // Don't wake if supervisor is mid-turn
    const supState = this.deps.getSupervisorState();
    if (supState && supState !== 'idle') return;

    const lines: string[] = [];
    for (const wid of this.trackedWorkers) {
      const status = this.deps.getWorkerStatus(wid);
      const ago = status.lastActivity
        ? formatElapsed(Date.now() - new Date(status.lastActivity).getTime())
        : '?';
      lines.push(`${wid}: ${status.state}, ${status.contextPct ?? '?'}% ctx, $${status.cost.toFixed(2)}, last activity ${ago}`);
    }
    if (lines.length === 0) return;

    const text = `🤖 [heartbeat] ${lines.join(' | ')}`;
    this.deps.setMuteOutput(this.supervisorId, true);
    this.deps.sendToCC(this.supervisorId, wrapSystemReminder(text));
  }
}

/** Format milliseconds as a human-readable elapsed string (e.g. "3s", "3m", "1h 5m"). */
export function formatElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}
