# TGCC Supervisor Protocol

> How the supervisor agent manages workers. No custom socket protocol — MCP tools are the interface, Telegram is the control plane.

## 1. Overview

TGCC designates one agent as the **supervisor**. The supervisor is a regular CC instance with elevated privileges: it receives automatic worker event notifications and gets additional MCP tools to manage workers. All other agents are **workers**.

The protocol is entirely MCP-based. The supervisor's CC process calls MCP tools served by the bridge's MCP server (same process, same Unix socket). The supervisor's Telegram chat serves as the real-time notification channel for worker events.

There is no custom socket protocol, no NDJSON wire format, no separate client library.

## 2. Configuration

The `supervisor` field in `~/.tgcc/config.json` designates the supervisor agent:

```json
{
  "supervisor": "main",
  "agents": {
    "main": { ... },
    "sentinella": { ... },
    "linds": { ... }
  }
}
```

- Defaults to the first agent in the `agents` object if not specified
- Set to `null` to disable the native supervisor
- Must reference a valid agent ID from the `agents` map
- Only one supervisor at a time

The supervisor agent is configured in `src/config.ts` as `TgccConfig.supervisor: string | null`. At bridge startup, `this.nativeSupervisorId` is set from `config.supervisor`.

## 3. Architecture

```
                  ┌──────────────────────────────────────┐
                  │         TGCC Bridge Process           │
                  │                                      │
                  │  ┌──────────┐    ┌────────────────┐  │
                  │  │ Supervisor│    │ Worker Agents   │  │
                  │  │ Agent    │    │ (sentinella,    │  │
                  │  │ (main)   │    │  linds, eph-*)  │  │
                  │  └─────┬────┘    └───────┬────────┘  │
                  │        │                 │           │
                  │        │   MCP tools     │ events    │
                  │        ▼                 ▼           │
                  │  ┌──────────────────────────────┐    │
                  │  │   Bridge (handleMcpToolRequest)   │
                  │  │   + HighSignalDetector            │
                  │  │   + EventDedup                    │
                  │  │   + supervisorEventQueue          │
                  │  └──────────────────────────────┘    │
                  │        │                             │
                  │        ▼                             │
                  │  ┌──────────────┐                    │
                  │  │ Supervisor TG │                    │
                  │  │ Chat (Fnz)   │                    │
                  │  └──────────────┘                    │
                  └──────────────────────────────────────┘
```

The supervisor's CC process communicates with the bridge via Unix socket MCP (same mechanism as all other MCP tools like `send_file`). The bridge routes tool requests through `handleMcpToolRequest`, which gates access: only the supervisor agent (or internal callers like cron) may use `tgcc_*` tools.

## 4. MCP Tools

The supervisor agent's CC instance receives additional MCP tools beyond the standard set. These are registered conditionally in `src/mcp-server.ts` when `TGCC_IS_SUPERVISOR=1`.

### 4.1 Worker Management

#### `tgcc_status([agentId])`

Get status of all workers or a specific worker. The supervisor itself is excluded from results.

Returns per agent:
- `state`: idle | active
- `sessionId`: current CC session ID or null
- `ephemeral`: boolean
- `repo`: repository path
- `model`: current model
- `lastActivity`: timestamp
- `lastActivitySummary`: last event buffer line
- `sessionCost`: cumulative USD cost for the current session
- `tracked`: whether real-time TG notifications are enabled for this worker

#### `tgcc_send(agentId, text, [options])`

Send a message or task to a worker agent. If the worker has no active CC process, one is spawned. Automatically tracks the worker (enables real-time TG notifications). Registers a wake-on-complete ping so the supervisor's TG gets a notification when the worker's turn finishes.

Options:
- `newSession: boolean` -- clear session before sending
- `followUp: boolean` -- only send if the worker's CC is already active (no spawn); returns error if idle
- `waitForIdle: boolean` -- queue the message and deliver after the worker finishes its current turn; if already idle, sends immediately
- `sessionId: string` -- resume a specific session

The message is labeled in the worker's CC context as `[From supervisor <supervisorAgentId>]: <text>`. If the worker has a TG bot, a blockquote notification is posted to its TG chat.

#### `tgcc_kill(agentId)`

Kill a worker's CC process. The agent registration is preserved -- the worker can be restarted later with `tgcc_send`.

#### `tgcc_log(agentId, [options])`

Read a worker's event buffer (ring buffer of tool calls, errors, text output, system events).

Options:
- `limit: number` -- max entries (default 50)
- `since: number` -- only entries from last N milliseconds
- `type: 'text' | 'tool' | 'system' | 'error' | 'user'` -- filter by entry type
- `grep: string` -- filter by regex pattern

### 4.2 Session Management

#### `tgcc_session(agentId, action, [options])`

Manage a worker's session lifecycle without sending a message.

| Action | Description | Params |
|--------|-------------|--------|
| `list` | Discover CC sessions for the worker's repo | `limit?: number` |
| `new` | Force the next send to create a new session | -- |
| `continue` | Kill current process, set up resume of the current/most-recent session | -- |
| `resume` | Kill current process, set pending session to a specific ID | `sessionId: string` |
| `cancel` | Cancel the worker's current CC turn (ctrl+c equivalent) | -- |
| `compact` | Send `/compact` to the active CC process | `instructions?: string` |
| `set_model` | Change the worker's model and restart its CC process | `model: string` |
| `set_repo` | Change the worker's repo and restart | `repo: string` |
| `set_permissions` | Change permission mode and restart | `mode: 'dangerously-skip' \| 'acceptEdits' \| 'default' \| 'plan'` |

### 4.3 Ephemeral Agents

#### `tgcc_spawn([agentId], repo, [options])`

Spawn a temporary agent with a CC process. No Telegram bot -- supervisor only. The agent auto-destroys when its CC session ends or on explicit `tgcc_destroy`.

Params:
- `agentId?: string` -- ID for the agent (auto-generated as `eph-<uuid8>` if omitted)
- `repo: string` -- absolute path to the repository (required)
- `model?: string` -- model to use (default: sonnet)
- `message?: string` -- initial prompt sent immediately after spawning
- `timeoutMs?: number` -- auto-destroy after this many milliseconds
- `permissionMode?: string` -- `dangerously-skip`, `acceptEdits`, `default`, or `plan`

Returns: `{ agentId, state: 'spawning' | 'idle', repo, model }`

Ephemeral agents:
- Have no TG bot (`tgBot: null`)
- Are not persisted in config
- Auto-destroy on CC session end or process exit (if no deferred sends are pending)
- Can be managed with all other `tgcc_*` tools while alive

#### `tgcc_destroy(agentId)`

Destroy an ephemeral agent. Kills its CC process if running and removes it from the agent registry. Only works on ephemeral agents -- persistent agents cannot be destroyed via this tool.

### 4.4 Worker Tracking

#### `tgcc_track(agentId)`

Start receiving high-signal events from a worker in real time via the supervisor's TG chat. Tracking persists until the supervisor session ends or explicit `tgcc_untrack`.

Note: `tgcc_send` automatically tracks the target worker. `tgcc_track` is for passive observation without sending a message.

#### `tgcc_untrack(agentId)`

Stop receiving real-time TG notifications for a worker. Events are still queued in the supervisor event queue and delivered when the supervisor's next CC turn starts.

### 4.5 Common Tools (Available to All Agents)

These are not supervisor-specific but are part of the protocol:

- `notify_parent` -- worker sends a message to the supervisor's event queue and TG chat
- `supervisor_exec` -- request the supervisor to execute a shell command (requires external supervisor connection)
- `supervisor_notify` -- send a notification through the supervisor to the user's TG

## 5. Event Flow

### 5.1 High-Signal Detection

The `HighSignalDetector` (in `src/high-signal.ts`) watches CC stream events and emits structured events:

| Event | Trigger | Emoji |
|-------|---------|-------|
| `build_result` | Build/test command completes (npm, tsc, jest, etc.) | `🔨` |
| `git_commit` | `git commit` detected in Bash output | `📝` |
| `context_pressure` | Token usage crosses 50/75/90% of 200k window | `🧠` |
| `subagent_spawn` | CC uses Task/dispatch_agent/create_agent tool | `🔄` |
| `failure_loop` | 3+ consecutive tool failures | `🔁` |
| `task_milestone` | TodoWrite call with progress update | `📋` |
| `stuck` | No CC output for 5 minutes | `⚠️` |
| `budget_alert` | Session cost crosses $1/$5/$10/$25 thresholds | `💰` |

### 5.2 Event Routing Pipeline

```
CC stream events
    │
    ▼
HighSignalDetector.handleStreamEvent()
HighSignalDetector.handleToolResult()
    │
    ├── pushEventBuffer() → per-agent EventBuffer (ring buffer)
    │
    └── emitSupervisorEvent()
            │
            ├── External supervisor (OpenClaw) → sendToSupervisor() [if subscribed]
            │
            └── Native supervisor queue
                    │
                    ▼
                EventDedup.shouldForward()
                    │
                    ▼
                pushSupervisorEvent(agentId, text)
                    │
                    ├── supervisorEventQueue.push(line)  [max 20, FIFO drop]
                    │
                    └── if tracked or forceTg:
                        → supervisor TG chat (blockquote notification)
```

### 5.3 Event Deduplication

The `EventDedup` layer filters noisy events before they reach the supervisor queue. Events like `git_commit` and `build_result` are batched and deduplicated so the supervisor sees a summary rather than every individual occurrence.

Routed events (from `HighSignalDetector` to native supervisor):
`failure_loop`, `stuck`, `task_milestone`, `build_result`, `git_commit`, `subagent_spawn`, `budget_alert`

Not routed (too noisy / low value):
- `context_pressure` at 50/75% (90% would be routed via the above set if configured)
- Compaction events
- Individual stream deltas

### 5.4 Supervisor Event Queue

The `supervisorEventQueue` is an in-memory array of formatted strings (max 20 entries, oldest dropped on overflow). Format: `🤖 [<agentId>] <emoji> <summary>`.

Queue draining: when the supervisor's CC process starts a new turn (`sendToCC` is called for the supervisor agent), queued events are prepended to the user message:

```
[Worker events since last session]
🤖 [sentinella] ✅ Turn complete · $0.43 · 34s
🤖 [linds] 📝 Committed: "add dark mode"
🤖 [sentinella] 🔨 Build failed: 2 errors

<actual user message>
```

### 5.5 Turn Completion Events

When a worker completes a turn, the bridge routes a turn-complete event:
- `pushSupervisorEvent(agentId, "✅ Turn complete <cost>")` -- queued (not sent to TG unless tracked)
- If the worker was sent a message by the supervisor (`supervisorWakeOnComplete = true`):
  - An enriched `💬 Turn complete` event with the sent/reply context is pushed
  - A silent TG wake ping is sent to the supervisor's chat (`wakeSupervisorTg`)

### 5.6 Supervisor Self-Events

The supervisor does not receive events about itself. `pushSupervisorEvent` is a no-op when `sourceAgentId === nativeSupervisorId`.

## 6. Access Control

All `tgcc_*` tools are gated in `handleMcpToolRequest`:

```typescript
if (request.agentId !== this.nativeSupervisorId && !isInternalCaller) {
  return { error: 'Only the supervisor agent may use tgcc_* tools' };
}
```

Internal callers (`userId === 'cron'` or `userId === 'system'`) bypass this check, allowing cron jobs and system-level operations to use supervisor tools.

Workers cannot call `tgcc_*` tools. They can only communicate upward via `notify_parent`.

## 7. External Supervisor (Legacy)

The bridge also supports an external supervisor protocol for OpenClaw integration. This uses a Unix socket connection where an external process registers as supervisor and exchanges NDJSON commands/events. Both native and external supervisors can coexist: events are routed to both when active.

The external supervisor path uses `this.supervisorWrite`, `supervisorSubscriptions`, and `supervisorPendingRequests` -- separate from the native supervisor machinery. This is a legacy path; the native supervisor model described in this document is the primary architecture.

## 8. Key Implementation Files

| File | Role |
|------|------|
| `src/config.ts` | `TgccConfig.supervisor` field, validation |
| `src/mcp-server.ts` | MCP tool definitions, `IS_SUPERVISOR` conditional registration |
| `src/bridge.ts` | `handleMcpToolRequest` routing, `pushSupervisorEvent`, `sendSupervisorMessage`, event queue, tracked workers |
| `src/high-signal.ts` | `HighSignalDetector` -- stream event analysis, structured event emission |
| `src/event-dedup.ts` | `EventDedup` -- batching and deduplication before supervisor queue |
| `src/cc-process.ts` | MCP config generation, `TGCC_IS_SUPERVISOR` env var injection |
