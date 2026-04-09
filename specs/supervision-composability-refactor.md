# TGCC Supervision & Signalling — Composability Refactor

## Introduction: What This Unlocks

Today, TGCC's supervision features (ralph, tracking, heartbeats, cron, high-signal detection) are welded into a 4700+ line Bridge class as private methods with special-cased logic. Ralph can only be a "completion shepherd" — not a general watcher. Tracking is supervisor-only. Tool access is gated by a single boolean. Events take hardcoded paths through three inline routing branches.

After this refactor, these features become **composable primitives**:

- **Any agent can watch any other agent** — not just ralph. A CI agent could watch a dev agent. A QA agent could watch a deploy agent. The `WatcherManager` handles subscription, delivery, and cleanup generically.
- **Event routing is a pipeline, not a switch statement** — `HighSignalDetector → EventDedup → EventRouter → subscribers`. Adding a new consumer (webhook? Discord? log file?) is one `router.subscribe()` call.
- **Capability-based tool access** — instead of `IS_SUPERVISOR=1` granting everything, agents get granular capabilities: `observe`, `manage`, `schedule`, `watch:self`. Ralph gets exactly the tools it needs, not the full supervisor toolbelt.
- **Ralph becomes a pattern, not a special case** — `RalphManager` is a consumer of `WatcherManager`, not a parallel system. You could create other "watcher patterns" (a budget monitor, a progress reporter) using the same infrastructure.
- **Bridge shrinks by ~400 lines** — supervision logic moves to focused 100-200 line modules with clear interfaces.

---

## Part 1: Current Implementation Inventory

### 1.1 Ralph — Completion Shepherd

Ralph is an ephemeral sonnet agent that watches a target worker until task completion, nudging if stuck.

| Piece | Location | What it does |
|-------|----------|-------------|
| `WatcherInfo` interface | bridge.ts:92-95 | `{ watcherAgentId, includeReply }` |
| `RalphMeta` interface | bridge.ts:97-100 | `{ targetAgentId, invokerChatId, invokerAgentId }` |
| `AgentInstance.watchedBy` | bridge.ts:133 | `Map<string, WatcherInfo>` on every agent — only used by ralph |
| `AgentInstance._ralphMeta` | bridge.ts:134 | Optional, set only on ralph instances |
| `buildRalphPrompt()` | bridge.ts:249-322 | Builds system prompt with target status, event log, session history |
| `notifyWatchers()` | bridge.ts:428-439 | Iterates `watchedBy`, sends text via `sendToCC()` |
| `spawnRalph()` | bridge.ts:4467-4580 | Creates ephemeral agent, registers watcher, sets timeout |
| `destroyEphemeralAgent()` | bridge.ts:4444-4463 | Cleanup with ralph-specific `watchedBy` removal |
| `ralph_done` MCP handler | bridge.ts:3751-3777 | Unregisters watcher, notifies invoker on TG, self-destructs |
| `tgcc_ralph` MCP handler | bridge.ts:3737-3749 | Entry point from supervisor MCP tool |
| `ralph_done` MCP registration | mcp-server.ts:407-421 | Tool schema: `summary: string, success?: boolean` |
| `tgcc_ralph` MCP registration | mcp-server.ts:559-583 | Tool schema: `agentId, prompt, timeoutMs?` |
| `/ralph` TG command | bridge.ts:2602-2622 | TG entry point: `/ralph <prompt>` |
| `extractRecentConversation()` | session.ts:504-550 | Reads last 8 messages from JSONL for ralph context |

**CC Source match**: Ralph has no CC-side equivalent — it's a TGCC-native feature. The watcher pattern is loosely analogous to CC's `useInboxPoller` (teammates watching their inbox for messages), but ralph uses direct CC process text injection instead of mailbox files.

**Notification call sites** (`notifyWatchers` is called from):
- High-signal events (bridge.ts:402)
- Turn completion (bridge.ts:2060, 2129)
- Process exit (bridge.ts:1841)
- Agent destruction (bridge.ts:4450)

### 1.2 Supervisor Tracking & Event Queue

The native supervisor (the main TGCC operator agent) receives worker events via a queue that wakes its CC process.

| Piece | Location | What it does |
|-------|----------|-------------|
| `trackedWorkers: Set<string>` | bridge.ts:351 | Which workers get real-time TG forwarding |
| `supervisorEventQueue: string[]` | bridge.ts:348 | Max 20 messages, drained on wake |
| `SUPERVISOR_QUEUE_MAX` | bridge.ts (constant) | 20 |
| `pushSupervisorEvent()` | bridge.ts:501-511 | Format + queue + optional TG forward |
| `wakeSupervisor()` | bridge.ts:413-425 | Drain queue → `sendToCC()` with `muteOutput=true` |
| `isSupervisorSubscribed()` | bridge.ts:3948-3951 | Check external plugin subscriptions |
| `supervisorSubscriptions: Set` | bridge.ts | `agentId:sessionId` or `agentId:*` patterns |
| `sendToSupervisor()` | bridge.ts:4426-4429 | Send raw event to external supervisor plugin |
| `tgcc_track` handler | bridge.ts:3780-3799 | Add to trackedWorkers, start heartbeat |
| `tgcc_untrack` handler | bridge.ts:3803-3809 | Remove from trackedWorkers |
| `supervisorWakeOnComplete` | AgentInstance field | Flag: wake supervisor when this agent's turn ends |
| `muteOutput` | AgentInstance field | Suppress TG rendering during supervisor wake |

**CC Source match**: CC's team lead uses `useInboxPoller` to watch teammate inboxes (file-based). TGCC replaces this with direct event routing — no file I/O, no polling.

### 1.3 High-Signal Detection

Watches CC stream events for meaningful patterns and emits structured events.

| Piece | Location | What it does |
|-------|----------|-------------|
| `HighSignalDetector` class | high-signal.ts:75-85 | Stateful detector with per-agent tracking |
| `handleStreamEvent()` | high-signal.ts:92-118 | Process CC stream events (tool_use, text delta) |
| `handleToolResult()` | high-signal.ts:163-236 | Detect build results, git commits, failures, subagent spawns, task milestones |
| `handleTurnEnd()` | high-signal.ts:152-161 | Clear stuck timer, reset tool tracking |
| `handleCostUpdate()` | high-signal.ts:238-258 | Budget threshold alerts ($1, $5, $10, $25) |
| `getSessionCost()` | high-signal.ts:260-266 | Return accumulated cost |
| `getContextPercent()` | high-signal.ts:268-273 | Return context window usage % |
| `AgentState` interface | high-signal.ts:33-59 | Per-agent state: failures, context, cost, timers |
| `emit()` (private) | high-signal.ts:475-490 | Format event + call `emitSupervisorEvent` callback |

**Event types**: `build_result`, `git_commit`, `failure_loop`, `stuck`, `context_pressure`, `subagent_spawn`, `subagent_all_done`, `budget_alert`, `task_milestone`

**Already well-extracted** — this module needs no structural changes.

### 1.4 Event Deduplication

Filters noise before events reach the supervisor.

| Piece | Location | What it does |
|-------|----------|-------------|
| `EventDedup` class | event-dedup.ts:27-35 | Per-agent dedup state |
| `shouldForward()` | event-dedup.ts:42-65 | Per-event-type filtering rules |
| `batchGitCommit()` | event-dedup.ts:135-145 | Collect commits in 30s window |
| `flushGitBatch()` | event-dedup.ts:147-182 | Emit batched summary |

**Rules**: Suppress consecutive build passes. Batch git commits within 30s. Only forward first subagent spawn per turn. Everything else passes through.

**Already well-extracted** — no structural changes needed.

### 1.5 Heartbeat System

Periodic status pushes to the supervisor.

| Piece | Location | What it does |
|-------|----------|-------------|
| `startHeartbeat()` | bridge.ts:442-448 | Start interval timer |
| `stopHeartbeat()` | bridge.ts:451-458 | Clear timer |
| `heartbeatTick()` | bridge.ts:461-485 | Collect tracked worker status, push to queue, wake supervisor |
| Per-agent heartbeat | bridge.ts:795-821 | Config-driven, reads `heartbeat-rules.txt`, sends via `sendToCC` |

### 1.6 Cron System

Scheduled message delivery to agents.

| Piece | Location | What it does |
|-------|----------|-------------|
| `Scheduler` class | scheduler.ts | Manages cron jobs + per-agent heartbeats |
| `addDynamicJob()` | scheduler.ts:276-299 | Create job, persist to `~/.config/tgcc/cron-jobs.json` |
| `removeDynamicJob()` | scheduler.ts:302-309 | Stop + remove + persist |
| `listJobs()` | scheduler.ts:359-378 | Return all jobs with next-run times |
| `triggerJob()` | scheduler.ts:327-353 | Manual fire |
| `spawnCronIsolated()` | bridge.ts:570-595 | Spawn ephemeral agent for isolated cron execution |
| `tgcc_cron` MCP handler | bridge.ts:3812-3908 | Actions: add, list, remove, trigger |
| `CronJobConfig` interface | config.ts:51-66 | Job schema: schedule, agentId, message, session, tz, etc. |

**Already mostly extracted** into Scheduler. Only `spawnCronIsolated()` and the MCP handler live in Bridge.

### 1.7 Event Routing (the hardcoded hub)

The routing callback in Bridge's constructor (bridge.ts:388-402) is where everything converges:

```
emitSupervisorEvent callback:
  1. External supervisor plugin → sendToSupervisor(event)       [raw, unfiltered]
  2. Native supervisor queue   → eventDedup → pushSupervisorEvent [deduped]
  3. Ralph watchers            → notifyWatchers(agentId, text)  [formatted, all events]
```

Plus lifecycle events (turn_complete, process_exit, agent_destroy) call `pushSupervisorEvent` and `notifyWatchers` separately from ~5 different locations in Bridge.

### 1.8 MCP Tool Gating

Currently binary: `IS_SUPERVISOR=1` env var in mcp-server.ts:13 gates all supervisor tools. Ralph gets supervisor tools because it's spawned with `isSupervisor: true`. This means ralph has access to `tgcc_cron`, `tgcc_track`, `tgcc_ralph` (ralph-ception) — tools it should never use.

---

## Part 2: Refactoring Analysis

### 2.1 Core Problem

Three concepts are tangled in Bridge:
1. **Who wants events** (subscribers: supervisor, ralph, external plugins)
2. **What events to deliver** (filtering: dedup, tracking, event types)
3. **How to deliver them** (mechanisms: CC text injection, TG blockquote, queue+wake, raw JSON)

Currently these are wired together in ad-hoc `if` branches. Adding a new subscriber type means touching 5+ locations in Bridge.

### 2.2 Proposed Modules

#### `src/event-router.ts` — EventRouter

Unified subscription + routing. Replaces the hardcoded callback + `trackedWorkers` + `watchedBy`.

```typescript
interface RoutableEvent {
  type: 'high_signal' | 'turn_complete' | 'process_exited' | 'agent_destroyed';
  agentId: string;
  event: string;
  emoji?: string;
  summary?: string;
  replySnippet?: string;
  cost?: string;
  isError?: boolean;
}

interface Subscription {
  subscriberId: string;
  watchAgentIds: Set<string>;   // empty = all agents
  eventTypes: Set<string>;      // empty = all events
  deliver: (subscriberId: string, event: RoutableEvent) => void;
  includeReply: boolean;
  meta?: Record<string, unknown>;
}

class EventRouter {
  subscribe(sub: Subscription): void;
  unsubscribe(subscriberId: string): void;
  routeHighSignal(event: HighSignalEvent): void;
  routeLifecycle(event: RoutableEvent): void;
  hasSubscribers(agentId: string): boolean;
  getSubscribers(agentId: string): string[];
}
```

**Key design choice**: EventDedup is applied per-subscriber-type, not globally. The supervisor subscription applies dedup; watcher subscriptions get everything raw.

#### `src/supervisor.ts` — SupervisorManager

Extracts all native supervisor state from Bridge.

```typescript
class SupervisorManager {
  trackedWorkers: Set<string>;
  pushEvent(sourceAgentId: string, text: string, notifyTg?: boolean, forceTg?: boolean): void;
  wake(sourceAgentId: string): void;
  track(agentId: string): void;
  untrack(agentId: string): void;
  startHeartbeat(intervalMs: number): void;
  stopHeartbeat(): void;
}
```

Registers itself as a subscriber on EventRouter. Owns the event queue, heartbeat timer, and TG forwarding logic.

**Removes from Bridge**: `supervisorEventQueue`, `trackedWorkers`, `pushSupervisorEvent()`, `wakeSupervisor()`, `heartbeatTick()`, `startHeartbeat()`, `stopHeartbeat()` (~120 lines).

#### `src/watcher.ts` — WatcherManager

Generic agent-watches-agent abstraction. Ralph becomes a consumer.

```typescript
class WatcherManager {
  addWatcher(config: { watcherId, targetAgentId, includeReply, meta? }): void;
  removeWatcher(watcherId: string): void;
  removeWatchersForTarget(targetAgentId: string): string[];
  getTarget(watcherId: string): string | undefined;
  hasWatchers(agentId: string): boolean;
}
```

Registers subscriptions on EventRouter. Formats events into `[event_type] emoji summary` text and delivers via `sendToCC()`.

**Removes from Bridge**: `notifyWatchers()`, `watchedBy` from AgentInstance, scattered `if (agent.watchedBy.size)` checks (~40 lines).

#### `src/ralph.ts` — RalphManager

Ralph lifecycle as a consumer of WatcherManager + SupervisorManager.

```typescript
class RalphManager {
  spawn(opts: { targetAgentId, prompt, invokerAgentId, invokerChatId, timeoutMs? }): { ralphId, error? };
  done(ralphId: string, summary: string, success: boolean): { error? };
  isRalph(agentId: string): boolean;
  getMeta(ralphId: string): RalphMeta | undefined;
  handleDestroyed(agentId: string): void;
}
```

Owns `RalphMeta` map (replaces `_ralphMeta` on AgentInstance), `buildRalphPrompt()`, timeout logic, TG notification.

**Removes from Bridge**: `spawnRalph()`, `buildRalphPrompt()`, ralph-specific `destroyEphemeralAgent()` logic, `ralph_done` handler body, `_ralphMeta` from AgentInstance (~180 lines).

### 2.3 Capability-Based Tool Access

Replace `IS_SUPERVISOR` boolean with `TGCC_CAPABILITIES` env var.

| Capability | Tools it unlocks |
|-----------|-----------------|
| `*` | Everything (native supervisor) |
| `observe` | `tgcc_status`, `tgcc_log`, `tgcc_track`, `tgcc_untrack` |
| `manage` | `tgcc_session`, `tgcc_kill`, `tgcc_destroy` |
| `schedule` | `tgcc_cron` |
| `watch:self` | `ralph_done` (only callable by the ralph itself) |
| `basic` | `tgcc_agents`, `tgcc_send`, `tgcc_spawn` |

**Agent capability assignments**:
- Native supervisor: `['*']`
- Ralph: `['observe', 'manage', 'watch:self', 'basic']`
- Ephemeral/persistent workers: `['basic']`

Changes: `cc-process.ts` `generateMcpConfig` signature (`isSupervisor: boolean` → `capabilities: string[]`), `mcp-server.ts` tool registration loop.

### 2.4 Event Pipeline After Refactor

```
CC Stream Events
     │
     ▼
HighSignalDetector  (unchanged — already extracted)
     │ emitSupervisorEvent callback
     ▼
EventRouter.routeHighSignal()
     │
     ├──▶ SupervisorManager subscription  ──dedup──▶  event queue + TG blockquote
     ├──▶ WatcherManager subscriptions    ──raw──▶   sendToCC(watcherId, formatted text)
     └──▶ External supervisor subscription ──raw──▶  sendToSupervisor(JSON)

Lifecycle events (turn_complete, process_exit, agent_destroy):
     │
     ▼
EventRouter.routeLifecycle()
     │
     ├──▶ SupervisorManager  ──▶  wake logic + queue
     └──▶ WatcherManager     ──▶  formatted text to watchers
```

---

## Part 3: Migration Path

Five phases, each producing a working commit:

### Phase 1: EventRouter (additive, zero risk)
- Create `src/event-router.ts`
- Wire into Bridge constructor **alongside** existing code
- Both old and new paths active — verify identical behavior
- Files: `event-router.ts` (new), `bridge.ts` (add router, keep old code)

### Phase 2: SupervisorManager (moderate, ~120 lines extracted)
- Create `src/supervisor.ts`
- Move queue, tracking, heartbeat, wake logic
- Bridge holds `SupervisorManager` instance, delegates
- Remove old private methods once verified
- Files: `supervisor.ts` (new), `bridge.ts` (delegate + remove)

### Phase 3: WatcherManager (low risk, ~40 lines)
- Create `src/watcher.ts`
- Remove `watchedBy` from AgentInstance
- Replace `notifyWatchers()` calls with `eventRouter.routeLifecycle()`
- Files: `watcher.ts` (new), `bridge.ts` (remove watchedBy + notifyWatchers)

### Phase 4: RalphManager (satisfying, ~180 lines extracted)
- Create `src/ralph.ts`
- Move `spawnRalph`, `buildRalphPrompt`, ralph-specific destroy logic, `ralph_done` handler
- Remove `_ralphMeta` from AgentInstance
- RalphManager uses WatcherManager + SupervisorManager
- Files: `ralph.ts` (new), `bridge.ts` (delegate + remove)

### Phase 5: Capability-based tool gating (interface change)
- `cc-process.ts`: `isSupervisor: boolean` → `capabilities: string[]`
- `mcp-server.ts`: `IS_SUPERVISOR` → `TGCC_CAPABILITIES` with per-tool capability check
- Bridge: store capabilities per AgentInstance
- Files: `cc-process.ts`, `mcp-server.ts`, `bridge.ts`

---

## Verification

After each phase:
1. `npm run build` — no type errors
2. `systemctl --user restart tgcc` — service starts
3. Send a message to a worker agent — verify events still flow to TG and supervisor
4. After Phase 4: `/ralph verify build` — ralph spawns, receives events, calls ralph_done
5. After Phase 5: verify ralph only sees its allowed tools (not tgcc_cron, tgcc_ralph)

---

## Files Summary

| File | Status | Lines ~changed |
|------|--------|---------------|
| `src/event-router.ts` | NEW | ~120 |
| `src/supervisor.ts` | NEW | ~150 |
| `src/watcher.ts` | NEW | ~100 |
| `src/ralph.ts` | NEW | ~200 |
| `src/bridge.ts` | MODIFIED | -400 (extract), +50 (delegate) |
| `src/cc-process.ts` | MODIFIED | ~10 (signature change) |
| `src/mcp-server.ts` | MODIFIED | ~30 (capability gating) |
| `src/high-signal.ts` | UNCHANGED | — |
| `src/event-dedup.ts` | UNCHANGED | — |
| `src/scheduler.ts` | UNCHANGED | — |
