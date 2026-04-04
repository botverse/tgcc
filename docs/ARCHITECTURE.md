# TGCC Architecture

> How TGCC manages agents, routes events, and exposes tools. MCP tools are the interface, Telegram is the control plane.

## 1. Overview

TGCC bridges Claude Code CLI sessions to Telegram. Each agent gets a Telegram bot that streams CC output in real-time. One agent is designated as the **supervisor** with elevated privileges to manage workers.

The system is entirely MCP-based. Every CC process gets an MCP server (Unix socket) with tools for Telegram interaction. The supervisor's CC process gets additional tools for worker management. There is no custom wire protocol.

## 2. Configuration

Config lives at `~/.tgcc/config.json`. The `supervisor` field designates the supervisor agent:

```json
{
  "supervisor": "main",
  "agents": {
    "main": { ... },
    "linds": { ... }
  }
}
```

- Defaults to the first agent if not specified
- Set to `null` to disable the supervisor
- Only one supervisor at a time

Implementation: `src/config.ts` (`TgccConfig.supervisor: string | null`), `bridge.ts` (`this.nativeSupervisorId`).

## 3. Agent Model

```
                  ┌──────────────────────────────────────┐
                  │         TGCC Bridge Process           │
                  │                                      │
                  │  ┌──────────┐    ┌────────────────┐  │
                  │  │ Supervisor│    │ Worker Agents   │  │
                  │  │ Agent    │    │ (linds,         │  │
                  │  │ (main)   │    │  eph-*)         │  │
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
                  │  │ Chat          │                    │
                  │  └──────────────┘                    │
                  └──────────────────────────────────────┘
```

Each agent has one repo, one CC process (at most), and one model. Agents don't know about users — `allowedUsers` is a system-level ACL. All allowed users share the same agent state.

### Ephemeral Agents

Any agent can spawn temporary agents via `tgcc_spawn` — no Telegram bot needed. Three modes:

1. **Fire & forget** — spawn with a message, returns immediately
2. **Async wake** — use `tgcc_send` after spawn, get woken when the agent's turn completes
3. **Sync (`waitForResult`)** — blocks until complete, returns text output, auto-destroys (120s default timeout)

Ephemeral agents auto-destroy on session end or process exit.

## 4. MCP Tools

### 4.1 All Agents (Tier 1)

Available to every CC process — workers and supervisor alike.

**Telegram tools:**

| Tool | Description |
|------|-------------|
| `send_file` | Send a file to the user on Telegram |
| `send_image` | Send an image with preview |
| `send_voice` | Send a voice message (.ogg opus) |
| `send_message` | Send a text message to the user |
| `notify_parent` | Send a message to the supervisor (info/question/blocker) |
| `supervisor_exec` | Request the supervisor to execute a shell command |
| `supervisor_notify` | Send a notification to the user through the supervisor |

**Coordination tools:**

| Tool | Description |
|------|-------------|
| `tgcc_agents` | List all registered agents with IDs, repos, models, state |
| `tgcc_status` | Get worker status: state, context%, cost, last activity |
| `tgcc_send` | Send a message/task to any agent (spawns CC if needed) |
| `tgcc_log` | Read a worker's event buffer (limit, since, type, grep filters) |
| `tgcc_spawn` | Spawn an ephemeral agent (fire-and-forget, async wake, or sync waitForResult) |
| `tgcc_destroy` | Destroy an ephemeral agent (kill + deregister) |

### 4.2 Supervisor Only (Tier 2)

Restricted to the supervisor agent ID and internal callers (`userId === 'cron'` or `userId === 'system'`).

| Tool | Description |
|------|-------------|
| `tgcc_kill` | Kill any agent's CC process (registration preserved) |
| `tgcc_session` | Session lifecycle: list, new, cancel, continue, resume, compact, set_model, set_repo, set_permissions |
| `tgcc_track` | Start receiving real-time events from a worker (optional heartbeat) |
| `tgcc_untrack` | Stop receiving real-time events (events still queued) |
| `tgcc_cron` | Runtime cron job management: add, list, remove, trigger |

### Tool Details

#### `tgcc_status([agentId])`

Returns per agent: `state`, `sessionId`, `ephemeral`, `repo`, `model`, `lastActivity`, `lastActivitySummary`, `sessionCost`, `contextPct`, `tracked`.

#### `tgcc_send(agentId, text, [options])`

Options: `newSession`, `followUp` (only if already active), `waitForIdle` (queue until turn ends), `sessionId` (resume specific session). Auto-tracks the worker. Registers wake-on-complete. Message labeled as `[From supervisor <id>]: <text>` in worker's CC context.

#### `tgcc_session(agentId, action, [options])`

| Action | Description | Params |
|--------|-------------|--------|
| `list` | Discover CC sessions for the worker's repo | `limit?: number` |
| `new` | Force next send to create a new session (kills process, clears pending) | `prompt?: string` |
| `continue` | Kill current process, resume current/most-recent session | -- |
| `resume` | Kill current process, set pending session to specific ID | `sessionId` |
| `cancel` | Cancel current CC turn (ctrl+c equivalent) | -- |
| `compact` | Send `/compact` to active CC process | `instructions?: string` |
| `set_model` | Change model and restart | `model` |
| `set_repo` | Change repo and restart | `repo` |
| `set_permissions` | Change permission mode and restart | `mode` |

#### `tgcc_spawn([agentId], repo, [options])`

Params: `agentId?`, `repo` (required), `model?`, `message?`, `waitForResult?`, `timeoutMs?`, `permissionMode?`.

#### `tgcc_track(agentId, [heartbeatMs])`

`heartbeatMs` (min 30000) enables periodic status snapshots:
```
[heartbeat] saemem: busy, 42% ctx, $7.86, last activity 12s | linds: idle, 18% ctx, $0.18, last activity 3m
```
Heartbeat ticks suppressed when supervisor is mid-turn. `tgcc_send` auto-tracks. Last worker untracked stops heartbeat.

#### `tgcc_cron(action, [options])`

Jobs persist to `~/.config/tgcc/cron-jobs.json`.

| Action | Required params |
|--------|-----------------|
| `add` | `agentId`, `message`, one of: `every`, `at`, `cron` |
| `list` | -- |
| `remove` | `jobId` (dynamic only) |
| `trigger` | `jobId` |

Schedule params (mutually exclusive): `every` (e.g. `"30m"`), `at` (e.g. `"20m"`, one-shot), `cron` (raw expression). Optional: `name`, `tz`, `session` (main/isolated), `announce`.

#### `notify_parent(message, [priority])`

Priority levels: `info`, `question`, `blocker`. Routes to supervisor event queue + TG chat.

## 5. Event System

### 5.1 High-Signal Detection

`HighSignalDetector` (`src/high-signal.ts`) watches CC stream events and emits structured events:

| Event | Trigger | Emoji |
|-------|---------|-------|
| `build_result` | Build/test command completes | 🔨 |
| `git_commit` | `git commit` in Bash output | 📝 |
| `context_pressure` | Token usage crosses 50/75/90% | 🧠 |
| `subagent_spawn` | CC uses Agent/Task/SendMessage/TeamCreate | 🔄 |
| `failure_loop` | 3+ consecutive tool failures | 🔁 |
| `task_milestone` | TodoWrite call with progress | 📋 |
| `stuck` | No CC output for 5 minutes | ⚠️ |
| `budget_alert` | Session cost crosses $1/$5/$10/$25 | 💰 |

### 5.2 Event Routing Pipeline

```
CC stream events
    │
    ▼
HighSignalDetector.handleStreamEvent()
HighSignalDetector.handleToolResult()
    │
    ├── pushEventBuffer() → per-agent EventBuffer (ring buffer, 1000 entries)
    │       └── queried by tgcc_log
    │
    └── emitSupervisorEvent()
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

`EventDedup` (`src/event-dedup.ts`) filters noise before routing:

| Event | Dedup rule |
|-------|------------|
| `build_result` | Consecutive passes suppressed — only first pass after failure forwards |
| `git_commit` | Batched in 30s window, flushed as single summary |
| `subagent_spawn` | Only first spawn per turn |
| `context_pressure` | Each threshold fires once per session (handled by HighSignalDetector) |
| Others | Pass through unfiltered |

### 5.4 Routed Events

Events forwarded to the native supervisor queue:
`failure_loop`, `stuck`, `task_milestone`, `build_result`, `git_commit`, `subagent_spawn`, `budget_alert`

Not routed: `context_pressure` (pull-only via `tgcc_log`), compaction events, stream deltas.

### 5.5 Supervisor Event Queue

In-memory array of formatted strings (max 20, oldest dropped on overflow). Format: `🤖 [<agentId>] <emoji> <summary>`.

Drained when supervisor's CC starts a new turn — prepended to user message:
```
[Worker events since last session]
🤖 [linds] 📝 Committed: "add dark mode"
🤖 [linds] 🔨 Build failed: 2 errors

<actual user message>
```

### 5.6 Turn Completion

- All workers: `pushSupervisorEvent(agentId, "✅ Turn complete <cost>")` — queued
- If worker was sent by supervisor (`supervisorWakeOnComplete`): enriched event with sent/reply context + silent TG wake ping

### 5.7 Self-Events

Supervisor does not receive events about itself. `pushSupervisorEvent` is a no-op when `sourceAgentId === nativeSupervisorId`.

### 5.8 Event Buffer

Per-agent `EventBuffer` (`src/event-buffer.ts`) — ring buffer of 1000 entries. Stores all CC output events (text, tool, thinking, system, error, user). Queried via `tgcc_log` with filters: `limit`, `since`, `type`, `grep`.

Log line types:

| Type | Source | Content |
|------|--------|---------|
| `text` | CC assistant text output | Response text |
| `thinking` | CC thinking blocks | Thinking content (truncated) |
| `tool` | Tool use + result | Tool name, duration, summary |
| `error` | API errors, crashes | Error message |
| `system` | Init, compact, high-signal events | System event description |
| `user` | User/supervisor messages sent | Input text + source |

## 6. Key Implementation Files

| File | Role |
|------|------|
| `src/bridge.ts` | Main orchestrator — agent management, MCP routing, event queue, tracked workers |
| `src/mcp-server.ts` | MCP tool definitions, two-tier registration (all-agent + supervisor-only) |
| `src/high-signal.ts` | `HighSignalDetector` — stream event analysis, structured event emission, cost/context tracking |
| `src/event-dedup.ts` | `EventDedup` — batching and deduplication before supervisor queue |
| `src/event-buffer.ts` | `EventBuffer` — per-agent ring buffer for `tgcc_log` queries |
| `src/streaming.ts` | `StreamAccumulator` — stream events → TG messages (see STREAMING-RENDERING.md) |
| `src/cc-process.ts` | CC process spawning, MCP config generation, `TGCC_IS_SUPERVISOR` env var |
| `src/cc-protocol.ts` | CC stream protocol types (see CC-PROTOCOL.md) |
| `src/session.ts` | Session discovery, JSONL parsing, project slug computation |
| `src/config.ts` | `TgccConfig` — supervisor field, agent config, cron jobs |
| `src/scheduler.ts` | Cron job scheduling — static + dynamic jobs, persistence |
| `src/telegram.ts` | Telegram bot wrapper |
| `src/ctl-server.ts` | Control socket server (Unix socket for external integrations) |
