// ── Event Router ──
//
// Unified subscription + routing for all event consumers (supervisor, watchers, external plugins).
// Replaces hardcoded routing in Bridge constructor, trackedWorkers set, and watchedBy map.

import type { HighSignalEvent } from './high-signal.js';

// ── Types ──

/** A routable event — extends HighSignalEvent with lifecycle events. */
export interface RoutableEvent {
  type: 'high_signal' | 'turn_complete' | 'process_exited' | 'agent_destroyed';
  agentId: string;
  event: string;
  emoji?: string;
  summary?: string;
  /** For turn_complete: the assistant reply snippet. */
  replySnippet?: string;
  /** For turn_complete: cost string like "$0.1234". */
  cost?: string;
  isError?: boolean;
  /** Pass-through for high_signal event-specific fields. */
  [key: string]: unknown;
}

export type DeliveryFn = (subscriberId: string, event: RoutableEvent) => void;

/** A subscription to routed events. */
export interface Subscription {
  subscriberId: string;
  /** Which agent IDs to receive events from. Empty set = all agents. */
  watchAgentIds: Set<string>;
  /** Which event types/names to receive. Empty set = all events. */
  eventTypes: Set<string>;
  /** Callback for event delivery. */
  deliver: DeliveryFn;
  /** Include reply text snippet in turn_complete events. */
  includeReply: boolean;
  /** Optional opaque metadata (e.g., watcher target info). */
  meta?: Record<string, unknown>;
}

// ── EventRouter ──

export class EventRouter {
  private subscriptions = new Map<string, Subscription>();

  /** Add or replace a subscription. */
  subscribe(sub: Subscription): void {
    this.subscriptions.set(sub.subscriberId, sub);
  }

  /** Remove a subscription by subscriber ID. */
  unsubscribe(subscriberId: string): void {
    this.subscriptions.delete(subscriberId);
  }

  /** Get a subscription by ID. */
  get(subscriberId: string): Subscription | undefined {
    return this.subscriptions.get(subscriberId);
  }

  /** Check if a given agentId has any matching subscribers. */
  hasSubscribers(agentId: string): boolean {
    for (const sub of this.subscriptions.values()) {
      if (sub.watchAgentIds.size === 0 || sub.watchAgentIds.has(agentId)) return true;
    }
    return false;
  }

  /** Get all subscriber IDs that match a given agent. */
  getSubscriberIds(agentId: string): string[] {
    const result: string[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.watchAgentIds.size === 0 || sub.watchAgentIds.has(agentId)) {
        result.push(sub.subscriberId);
      }
    }
    return result;
  }

  /** Route a HighSignalEvent to all matching subscribers. */
  routeHighSignal(event: HighSignalEvent): void {
    const routable: RoutableEvent = {
      type: 'high_signal',
      agentId: event.agentId,
      event: event.event,
      emoji: event.emoji,
      summary: event.summary,
    };
    this.deliver(routable);
  }

  /** Route a lifecycle event (turn_complete, process_exited, agent_destroyed). */
  routeLifecycle(event: RoutableEvent): void {
    this.deliver(event);
  }

  /** Remove all subscriptions that reference a specific agent (in watchAgentIds). */
  cleanupAgent(agentId: string): void {
    for (const sub of this.subscriptions.values()) {
      sub.watchAgentIds.delete(agentId);
    }
  }

  /** Remove all subscriptions. */
  destroy(): void {
    this.subscriptions.clear();
  }

  /** Number of active subscriptions. */
  get size(): number {
    return this.subscriptions.size;
  }

  private deliver(event: RoutableEvent): void {
    for (const sub of this.subscriptions.values()) {
      if (!this.matches(sub, event)) continue;

      // Strip reply snippet if subscriber doesn't want it
      if (!sub.includeReply && event.replySnippet) {
        const { replySnippet: _, ...stripped } = event;
        sub.deliver(sub.subscriberId, stripped as RoutableEvent);
      } else {
        sub.deliver(sub.subscriberId, event);
      }
    }
  }

  private matches(sub: Subscription, event: RoutableEvent): boolean {
    // Check agent filter
    if (sub.watchAgentIds.size > 0 && !sub.watchAgentIds.has(event.agentId)) return false;
    // Check event type filter — match against both event.type ('high_signal') and event.event ('build_result')
    if (sub.eventTypes.size > 0 && !sub.eventTypes.has(event.type) && !sub.eventTypes.has(event.event)) return false;
    return true;
  }
}
