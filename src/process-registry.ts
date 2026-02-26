/**
 * ProcessRegistry — Global singleton for shared CC process management.
 *
 * Keys processes by `repo:sessionId` instead of per-agent userId,
 * allowing multiple agents/users to subscribe to a single CC process.
 */

import type { CCProcess } from './cc-process.js';
import type { StreamAccumulator, SubAgentTracker } from './streaming.js';

// ── Types ──

export interface ClientRef {
  agentId: string;
  userId: string;
  chatId: number;
}

export interface Subscriber {
  client: ClientRef;
  accumulator: StreamAccumulator | null;  // created lazily on first stream event
  tracker: SubAgentTracker | null;        // created lazily alongside accumulator
}

export interface ProcessEntry {
  ccProcess: CCProcess;
  repo: string;
  sessionId: string;
  model: string;
  owner: ClientRef;
  subscribers: Map<string, Subscriber>;  // clientKey → subscriber
}

// ── Helpers ──

function processKey(repo: string, sessionId: string): string {
  return `${repo}:${sessionId}`;
}

function clientKey(ref: ClientRef): string {
  return `${ref.agentId}:${ref.userId}:${ref.chatId}`;
}

// ── Registry ──

export class ProcessRegistry {
  private entries = new Map<string, ProcessEntry>();
  // Reverse index: clientKey → processKey (for fast lookup by client)
  private clientIndex = new Map<string, string>();

  /** Get existing process entry for a repo+session, or null. */
  get(repo: string, sessionId: string): ProcessEntry | null {
    return this.entries.get(processKey(repo, sessionId)) ?? null;
  }

  /** Register a new process and subscribe the owner. */
  register(repo: string, sessionId: string, model: string, proc: CCProcess, owner: ClientRef): ProcessEntry {
    const pKey = processKey(repo, sessionId);
    const cKey = clientKey(owner);

    const entry: ProcessEntry = {
      ccProcess: proc,
      repo,
      sessionId,
      model,
      owner,
      subscribers: new Map(),
    };

    // Owner is always the first subscriber
    entry.subscribers.set(cKey, {
      client: owner,
      accumulator: null,
      tracker: null,
    });

    this.entries.set(pKey, entry);
    this.clientIndex.set(cKey, pKey);

    return entry;
  }

  /** Subscribe an additional client to an existing process. Returns the entry, or null if not found. */
  subscribe(repo: string, sessionId: string, client: ClientRef): ProcessEntry | null {
    const pKey = processKey(repo, sessionId);
    const entry = this.entries.get(pKey);
    if (!entry) return null;

    const cKey = clientKey(client);

    // Already subscribed? Just return.
    if (!entry.subscribers.has(cKey)) {
      entry.subscribers.set(cKey, {
        client,
        accumulator: null,
        tracker: null,
      });
    }

    this.clientIndex.set(cKey, pKey);
    return entry;
  }

  /** Unsubscribe a client. Returns true if the process was destroyed (no subscribers left). */
  unsubscribe(client: ClientRef): boolean {
    const cKey = clientKey(client);
    const pKey = this.clientIndex.get(cKey);
    if (!pKey) return false;

    const entry = this.entries.get(pKey);
    if (!entry) {
      this.clientIndex.delete(cKey);
      return false;
    }

    // Clean up subscriber's accumulator/tracker
    const sub = entry.subscribers.get(cKey);
    if (sub) {
      if (sub.accumulator) sub.accumulator.finalize();
      if (sub.tracker) sub.tracker.reset();
    }

    entry.subscribers.delete(cKey);
    this.clientIndex.delete(cKey);

    // If no subscribers remain, destroy the process
    if (entry.subscribers.size === 0) {
      entry.ccProcess.destroy();
      this.entries.delete(pKey);
      return true;
    }

    return false;
  }

  /** Find entry by client ref. */
  findByClient(client: ClientRef): ProcessEntry | null {
    const cKey = clientKey(client);
    const pKey = this.clientIndex.get(cKey);
    if (!pKey) return null;
    return this.entries.get(pKey) ?? null;
  }

  /** Find entry that owns a given CCProcess instance. */
  findByProcess(proc: CCProcess): ProcessEntry | null {
    for (const entry of this.entries.values()) {
      if (entry.ccProcess === proc) return entry;
    }
    return null;
  }

  /** Get subscriber for a specific client within an entry. */
  getSubscriber(entry: ProcessEntry, client: ClientRef): Subscriber | null {
    return entry.subscribers.get(clientKey(client)) ?? null;
  }

  /** Set accumulator for a subscriber. */
  setSubscriberAccumulator(entry: ProcessEntry, client: ClientRef, acc: StreamAccumulator): void {
    const sub = entry.subscribers.get(clientKey(client));
    if (sub) sub.accumulator = acc;
  }

  /** Set tracker for a subscriber. */
  setSubscriberTracker(entry: ProcessEntry, client: ClientRef, tracker: SubAgentTracker): void {
    const sub = entry.subscribers.get(clientKey(client));
    if (sub) sub.tracker = tracker;
  }

  /** Remove and destroy a process entry, cleaning up all subscribers. */
  destroy(repo: string, sessionId: string): void {
    const pKey = processKey(repo, sessionId);
    const entry = this.entries.get(pKey);
    if (!entry) return;

    // Clean up all subscribers
    for (const [cKey, sub] of entry.subscribers) {
      if (sub.accumulator) sub.accumulator.finalize();
      if (sub.tracker) sub.tracker.reset();
      this.clientIndex.delete(cKey);
    }

    entry.ccProcess.destroy();
    this.entries.delete(pKey);
  }

  /** Remove entry without destroying the process (caller manages destruction). */
  remove(repo: string, sessionId: string): void {
    const pKey = processKey(repo, sessionId);
    const entry = this.entries.get(pKey);
    if (!entry) return;

    for (const [cKey, sub] of entry.subscribers) {
      if (sub.accumulator) sub.accumulator.finalize();
      if (sub.tracker) sub.tracker.reset();
      this.clientIndex.delete(cKey);
    }

    this.entries.delete(pKey);
  }

  /** Iterate all subscribers of an entry. */
  *subscribers(entry: ProcessEntry): IterableIterator<Subscriber> {
    for (const sub of entry.subscribers.values()) {
      yield sub;
    }
  }

  /** Check if a client is subscribed anywhere. */
  hasClient(client: ClientRef): boolean {
    return this.clientIndex.has(clientKey(client));
  }

  /** Get all entries (for shutdown). */
  allEntries(): ProcessEntry[] {
    return [...this.entries.values()];
  }

  /** Clear everything. */
  clear(): void {
    this.entries.clear();
    this.clientIndex.clear();
  }
}
