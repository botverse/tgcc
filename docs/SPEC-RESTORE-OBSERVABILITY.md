# SPEC: Observability Architecture

**Status:** Implemented
**Date:** 2026-03-12
**Replaces:** Original draft from 2026-03-03 (plugin-era references)

## Overview

TGCC provides full observability into worker CC sessions through a layered architecture: event detection, deduplication, routing, and MCP tools. The supervisor agent (BossBot) receives high-signal events in real time via Telegram and can pull detailed logs on demand.

All observability infrastructure lives inside the TGCC codebase. There is no external plugin — the supervisor interacts through MCP tools exposed by `src/mcp-server.ts` and receives push notifications in its Telegram chat.

## Architecture

```
CC stream events
    │
    ▼
HighSignalDetector (src/high-signal.ts)
    │  detects: build_result, git_commit, context_pressure, failure_loop,
    │           stuck, task_milestone, subagent_spawn, budget_alert
    │
    ├──► EventBuffer (src/event-buffer.ts)  — per-agent ring buffer (1000 entries)
    │        └── queried by tgcc_log tool
    │
    └──► EventDedup (src/event-dedup.ts)    — noise filter
              │
              ▼
         pushSupervisorEvent() (src/bridge.ts)
              │
              ├──► supervisorEventQueue[]  — drained into supervisor's next CC message
              │
              └──► Telegram blockquote     — real-time post to supervisor chat
                   (only if worker is tracked)
```

### Key files

| File | Role |
|---|---|
| `src/high-signal.ts` | `HighSignalDetector` class — watches CC stream for meaningful patterns |
| `src/event-dedup.ts` | `EventDedup` class — suppresses noise before routing to supervisor |
| `src/event-buffer.ts` | `EventBuffer` class — per-agent ring buffer for `tgcc_log` queries |
| `src/bridge.ts` | `pushSupervisorEvent()` — routes events to queue and Telegram chat |
| `src/mcp-server.ts` | MCP tool definitions (supervisor-only tools gated by `IS_SUPERVISOR`) |

## Event Detection (`src/high-signal.ts`)

`HighSignalDetector` processes raw CC stream events and emits structured `HighSignalEvent` objects. Each event gets an emoji and a one-line summary.

| Event | Trigger | Example summary |
|---|---|---|
| `build_result` | Bash tool runs a build/test command | `Build passed` or `Build failed: 3 errors` |
| `git_commit` | Bash tool runs `git commit` | `Committed: "fix auth bug"` |
| `context_pressure` | Token usage crosses 50%, 75%, or 90% | `Context at 75%` |
| `failure_loop` | 3+ consecutive tool errors | `3 consecutive failures — possibly stuck` |
| `stuck` | No CC output for 5 minutes (outside tool execution) | `No output for 5min` |
| `task_milestone` | `TodoWrite` call with progress data | `[3/5] Run tests (in_progress)` |
| `subagent_spawn` | CC calls Task/dispatch_agent/AgentRunner | `Spawned: "implement auth"` |
| `budget_alert` | Session cost crosses $1, $5, $10, or $25 | `Session cost reached $5 (current: $5.23)` |

### Cost tracking

`handleCostUpdate()` is called on each CC `result` event with `total_cost_usd`. Budget thresholds are configurable (default: $1, $5, $10, $25). Each threshold fires exactly once per session.

`getSessionCost(agentId)` returns the current cumulative cost for any agent.

## Event Deduplication (`src/event-dedup.ts`)

`EventDedup` sits between detection and routing. It prevents noise from waking the supervisor on repetitive events.

| Event | Dedup rule |
|---|---|
| `build_result` | Consecutive passes suppressed — only the first pass after a failure (or first build) forwards |
| `git_commit` | Batched in a 30-second window, then flushed as a single summary (e.g., "3 commits (latest: ...)") |
| `subagent_spawn` | Only the first spawn per turn forwards |
| `context_pressure` | Already deduped by `HighSignalDetector` (each threshold fires once per session) |
| Others | Pass through unfiltered (`failure_loop`, `stuck`, `task_milestone`, `budget_alert`) |

## Event Routing (`src/bridge.ts`)

### Routed event set

Events that reach `pushSupervisorEvent()` after passing the dedup layer:

```typescript
const ROUTED_EVENTS = new Set([
  'failure_loop', 'stuck', 'task_milestone',
  'build_result', 'git_commit', 'subagent_spawn', 'budget_alert',
]);
```

`context_pressure` is intentionally excluded from supervisor routing (pull-only via `tgcc_log`).

### Two delivery paths

1. **Queue** (`supervisorEventQueue[]`): All routed events are appended. When the supervisor's next CC session starts, the queue is drained and prepended to the user message as `[Worker events since last session]`.

2. **Real-time Telegram** (`pushSupervisorEvent` with `notifyTg`): Events are posted as HTML blockquotes to the supervisor's Telegram chat — but only if the source worker is currently tracked. The `forceTg` flag bypasses the tracking check for explicit `notify_parent` calls.

### Worker tracking

Workers are tracked selectively. A tracked worker's high-signal events appear in the supervisor's Telegram chat in real time.

- `tgcc_track <agentId>` — start tracking
- `tgcc_untrack <agentId>` — stop tracking
- `tgcc_send` — implicitly tracks the target worker
- Tracked set clears when the supervisor's session ends

Untracked workers still have their events queued — they are delivered when the supervisor's next session starts.

### Turn-complete events

When a worker's CC turn ends, bridge.ts pushes a turn-complete event:

- Non-supervisor workers: `Turn complete` with cost
- `notify_parent` / `supervisor_notify` calls: forwarded with `forceTg = true`

If the worker was launched via `tgcc_send` with `supervisorWakeOnComplete`, a silent wake ping (`[agentId] ✅`) is sent to the supervisor's Telegram chat.

## MCP Tools (`src/mcp-server.ts`)

### All agents

These tools are available to every CC process (worker and supervisor):

| Tool | Description |
|---|---|
| `send_file` | Send a file to the user on Telegram |
| `send_image` | Send an image with preview to the user on Telegram |
| `send_voice` | Send a voice message (.ogg opus) to the user |
| `notify_parent` | Send a message to the supervisor (info/question/blocker priority) |
| `supervisor_exec` | Request the supervisor to execute a shell command |
| `supervisor_notify` | Send a notification to the user through the supervisor |

### Supervisor only

These tools are gated behind `IS_SUPERVISOR=1` and restricted to the supervisor agent ID at the bridge level:

| Tool | Description |
|---|---|
| `tgcc_status` | Get worker status: state, session ID, model, repo, cost, context, last activity, tracked flag |
| `tgcc_send` | Send a message/task to a worker (spawns CC if needed, implicitly tracks) |
| `tgcc_kill` | Kill a worker's CC process (registration preserved) |
| `tgcc_log` | Query a worker's event buffer (limit, since, type, grep filters) |
| `tgcc_session` | Session lifecycle: list, new, cancel, set_model, continue, resume, compact, set_repo, set_permissions |
| `tgcc_spawn` | Spawn an ephemeral agent with a CC process (no Telegram bot) |
| `tgcc_destroy` | Destroy an ephemeral agent (kill + deregister) |
| `tgcc_track` | Start receiving real-time high-signal events from a worker |
| `tgcc_untrack` | Stop receiving real-time events (events still queued) |

### `tgcc_status` output per agent

```json
{
  "state": "idle | running | ...",
  "sessionId": "...",
  "ephemeral": false,
  "repo": "/path/to/repo",
  "model": "sonnet",
  "lastActivity": "2026-03-12T...",
  "lastActivitySummary": "last event buffer entry text",
  "sessionCost": 2.45,
  "tracked": true
}
```

### `tgcc_log` query parameters

| Param | Type | Description |
|---|---|---|
| `agentId` | string | Worker agent ID (required) |
| `limit` | number | Max entries to return (default 50) |
| `since` | number | Only entries from last N milliseconds |
| `type` | enum | Filter: `text`, `tool`, `system`, `error`, `user` |
| `grep` | string | Regex pattern filter |

## Data Flow Summary

| Scenario | What happens |
|---|---|
| Worker builds successfully (first time) | `HighSignalDetector` emits `build_result` → `EventDedup` forwards (first pass) → `pushSupervisorEvent` queues it → if tracked, posts to TG |
| Worker builds successfully (again) | `EventDedup` suppresses (consecutive pass) |
| Worker makes 3 commits in 10s | `EventDedup` batches → after 30s window, flushes one summary: "3 commits (latest: ...)" |
| Worker hits $5 spend | `HighSignalDetector` emits `budget_alert` → passes dedup → forwarded to supervisor |
| Worker is stuck 5 min | `HighSignalDetector` emits `stuck` → forwarded to supervisor |
| Supervisor calls `tgcc_log` | Queries per-agent `EventBuffer` ring buffer directly |
| Supervisor starts new session | Queued events drained as `[Worker events since last session]` preamble |

## Non-Goals

- **External plugin architecture** — the OpenClaw plugin was replaced by the native supervisor model; all tools are in `src/mcp-server.ts`
- **Changing HighSignalDetector event types** — the current set covers all actionable patterns
- **Per-event wake policy in CC** — events wake the supervisor via Telegram chat (the supervisor's CC sees them as user messages or blockquote context), not by injecting into CC's conversation
