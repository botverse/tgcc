// ── Watcher Manager ──
//
// Generic agent-watches-agent abstraction. Any agent can subscribe to events
// from any other agent. Ralph is a consumer of this, not a special case.

import type { EventRouter, RoutableEvent } from './event-router.js';
import type pino from 'pino';
import { wrapSystemReminder } from './cc-tags.js';

// ── Types ──

export interface WatcherConfig {
  watcherId: string;
  targetAgentId: string;
  includeReply: boolean;
  /** Also forward events to the watcher's TG chat as blockquotes. */
  notifyTg?: boolean;
  /** Optional opaque metadata (e.g., { isRalph: true }). */
  meta?: Record<string, unknown>;
}

export interface WatcherDeps {
  /** Send text into a watcher's CC process stdin. */
  sendToCC: (watcherId: string, text: string) => void;
  /** Check if a watcher agent still exists. */
  agentExists: (agentId: string) => boolean;
  /** Send a TG blockquote to a specific agent's chat. */
  sendTgBlockquote?: (agentId: string, text: string) => Promise<void>;
}

// ── WatcherManager ──

export class WatcherManager {
  private router: EventRouter;
  private deps: WatcherDeps;
  private logger: pino.Logger;
  /** watcherId -> targetAgentId (for cleanup and lookups). */
  private watchers = new Map<string, string>();

  constructor(router: EventRouter, deps: WatcherDeps, logger: pino.Logger) {
    this.router = router;
    this.deps = deps;
    this.logger = logger;
  }

  /** Register a watcher on a target agent. Subscribes to EventRouter. */
  addWatcher(config: WatcherConfig): void {
    const subId = `watcher:${config.watcherId}:${config.targetAgentId}`;
    this.watchers.set(config.watcherId, config.targetAgentId);

    this.router.subscribe({
      subscriberId: subId,
      watchAgentIds: new Set([config.targetAgentId]),
      eventTypes: new Set(), // all events
      includeReply: config.includeReply,
      deliver: (_id, event) => {
        if (!this.deps.agentExists(config.watcherId)) {
          // Watcher was destroyed — clean up
          this.removeWatcher(config.watcherId);
          return;
        }
        const formatted = formatWatcherEvent(event);
        const text = wrapSystemReminder(formatted);
        this.deps.sendToCC(config.watcherId, text);

        // TG blockquote delivery (if enabled and dep available)
        if (config.notifyTg && this.deps.sendTgBlockquote) {
          const tgLine = `🤖 [${event.agentId}] ${formatted}`;
          this.deps.sendTgBlockquote(config.watcherId, tgLine).catch(err =>
            this.logger.warn({ err, watcherId: config.watcherId }, 'Failed to send watcher TG blockquote'),
          );
        }
      },
      meta: config.meta,
    });

    this.logger.debug({ watcherId: config.watcherId, targetAgentId: config.targetAgentId, notifyTg: !!config.notifyTg }, 'Watcher registered');
  }

  /** Remove a watcher subscription. */
  removeWatcher(watcherId: string): void {
    const targetId = this.watchers.get(watcherId);
    if (!targetId) return;
    this.router.unsubscribe(`watcher:${watcherId}:${targetId}`);
    this.watchers.delete(watcherId);
    this.logger.debug({ watcherId, targetId }, 'Watcher removed');
  }

  /** Remove all watchers targeting a specific agent (when the target is destroyed). Returns removed watcher IDs. */
  removeWatchersForTarget(targetAgentId: string): string[] {
    const removed: string[] = [];
    for (const [watcherId, target] of this.watchers) {
      if (target === targetAgentId) {
        this.router.unsubscribe(`watcher:${watcherId}:${targetAgentId}`);
        this.watchers.delete(watcherId);
        removed.push(watcherId);
      }
    }
    return removed;
  }

  /** Get the target agentId for a watcher. */
  getTarget(watcherId: string): string | undefined {
    return this.watchers.get(watcherId);
  }

  /** Check if a given agent has any watchers. */
  hasWatchers(agentId: string): boolean {
    for (const target of this.watchers.values()) {
      if (target === agentId) return true;
    }
    return false;
  }

  /** Get all watcher IDs for a given target. */
  getWatcherIds(targetAgentId: string): string[] {
    const ids: string[] = [];
    for (const [watcherId, target] of this.watchers) {
      if (target === targetAgentId) ids.push(watcherId);
    }
    return ids;
  }

  /** Number of active watchers. */
  get size(): number {
    return this.watchers.size;
  }

  /** Clean up all watchers. */
  destroy(): void {
    for (const [watcherId, targetId] of this.watchers) {
      this.router.unsubscribe(`watcher:${watcherId}:${targetId}`);
    }
    this.watchers.clear();
  }
}

/** Format a RoutableEvent into the text that watcher agents receive. */
function formatWatcherEvent(event: RoutableEvent): string {
  if (event.type === 'turn_complete') {
    const cost = event.cost ? ` · ${event.cost}` : '';
    const err = event.isError ? ' (error)' : '';
    const reply = event.replySnippet ? `\nReply: "${event.replySnippet}"` : '';
    return `[turn_complete] Agent ${event.agentId}${cost}${err}${reply}`;
  }
  if (event.type === 'process_exited') {
    return `[process_exited] Agent ${event.agentId} CC process exited`;
  }
  if (event.type === 'agent_destroyed') {
    return `[agent_exited] Agent ${event.agentId} was destroyed`;
  }
  // high_signal
  return `[${event.event}] ${event.emoji ?? ''} ${event.summary ?? JSON.stringify(event)}`.trim();
}
