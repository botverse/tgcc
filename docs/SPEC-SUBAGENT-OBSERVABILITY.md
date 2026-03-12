# Subagent Observability Spec

**Problem:** When a supervisor spawns a CC task via TGCC, the caller has zero visibility until the task completes or fails. Streaming all events into the caller's context would exhaust it — a single CC task can produce hundreds of events.

**Goal:** Push only high-signal alerts automatically; let the supervisor pull details on demand.

## Design Principles

1. **Context is precious** — every line injected into the caller's context costs tokens and attention
2. **Pull > Push** — let the caller decide when and how much to see
3. **Treat transcripts like files** — offset, limit, grep, just like reading code
4. **CC can talk back** — give spawned CC an explicit way to message its parent

## Architecture Note

TGCC emits all observability events natively through `pushSupervisorEvent()` in `bridge.ts` and the `HighSignalDetector` class in `high-signal.ts`. Events are routed to:

1. **Native supervisor event queue** — an in-memory queue (`supervisorEventQueue`) drained into the supervisor agent's next message. Any supervisor agent that reads this queue receives the events; there is no dependency on a specific consumer implementation.
2. **External supervisor protocol** — events are also forwarded via `sendToSupervisor()` to any external consumer connected through the stdin/stdout supervisor wire protocol (subscribe per agent/session).
3. **Telegram chat** — tracked workers' events are forwarded to the supervisor's TG chat in real time.
4. **EventBuffer** — per-agent ring buffer for pull-based log access via `tgcc_log`.

The `EventDedup` layer batches and deduplicates noisy events (e.g. consecutive git commits) before they reach the queue.

---

## 1. Push Notifications (automatic, into supervisor context)

Only inject into the supervisor's context when something needs attention:

| Event | When | Context cost |
|-------|------|-------------|
| Completion | Task finished (result text) | ~100-500 tokens |
| Error | API error, crash, permission block | ~50-100 tokens |
| Stuck | No progress for N minutes (configurable, default 5min) | ~30 tokens |
| Budget | Cost exceeded threshold ($1, $5, $10, $25) | ~30 tokens |
| Task milestone | CC creates/completes a todo item (TodoWrite) | ~30-50 tokens |
| Build/test result | Build or test pass/fail (highest signal for "is it done?") | ~30-50 tokens |
| Git commit | CC committed — message is a natural progress summary | ~30-50 tokens |
| Context pressure | Context window at 50%, 75%, 90% — quality may degrade | ~20 tokens |
| Sub-agent spawn | CC used Task tool to spawn sub-agents | ~30 tokens |
| Failure loop | 3+ consecutive tool failures (CC is stuck) | ~50 tokens |
| CC message | CC used `notify_parent` MCP tool | Variable |

**Format:** Short, actionable, one message per event:
```
[worker-id] Build passed
[worker-id] No output for 5min
[worker-id] Session cost reached $5 (current: $5.12)
[worker-id] [2/5] Read specs and source files (completed)
[worker-id] Build failed: 12 errors
[worker-id] Committed: "feat: add event ring buffer"
[worker-id] Context at 75%
[worker-id] Spawned: "refactor auth module"
[worker-id] 3 consecutive failures — possibly stuck
[worker-id] "Build fails — missing dep X. Install it?"
```

### TGCC Implementation

`HighSignalDetector` (in `high-signal.ts`) watches CC stream events and emits structured events through two callbacks:

- `emitSupervisorEvent(event)` — routes to the supervisor event queue and external supervisor protocol
- `pushEventBuffer(agentId, line)` — stores in the per-agent EventBuffer ring buffer

Events emitted by the detector:

```jsonc
// Build/test result (Bash tool with build/test command pattern)
{"type":"event", "event":"build_result", "agentId":"worker-1", "command":"npm run build", "passed":true, "errors":0, "summary":"Build/test passed"}

// Git commit (Bash tool with git commit command)
{"type":"event", "event":"git_commit", "agentId":"worker-1", "message":"feat: add event ring buffer"}

// Task milestone (TodoWrite tool use)
{"type":"event", "event":"task_milestone", "agentId":"worker-1", "task":"Read specs and source files", "status":"completed", "progress":"2/5"}

// Context pressure (from message_start usage stats)
{"type":"event", "event":"context_pressure", "agentId":"worker-1", "percent":75, "tokens":150000}

// Sub-agent spawn (Task/dispatch_agent/create_agent/AgentRunner tool use)
{"type":"event", "event":"subagent_spawn", "agentId":"worker-1", "count":1, "toolName":"Task", "label":"refactor auth module"}

// Failure loop (3+ consecutive tool failures)
{"type":"event", "event":"failure_loop", "agentId":"worker-1", "consecutiveFailures":3, "lastTool":"Bash", "lastError":"exit code 1"}

// Stuck (no output for N minutes, not during tool execution)
{"type":"event", "event":"stuck", "agentId":"worker-1", "silentMs":300000, "lastActivity":"2026-03-12T10:30:00.000Z"}

// Budget alert (configurable thresholds: $1, $5, $10, $25)
{"type":"event", "event":"budget_alert", "agentId":"worker-1", "threshold":5, "currentCost":5.12}

// CC notify_parent (via MCP tool)
{"type":"event", "event":"cc_message", "agentId":"worker-1", "text":"Build fails — missing dep X. Install it?", "priority":"question"}
```

Bridge-level events (emitted directly by `bridge.ts`, not through `HighSignalDetector`):

```jsonc
// Turn complete
{"type":"event", "event":"result", "agentId":"worker-1", "result":"...", "is_error":false, "total_cost_usd":0.34}

// Process lifecycle
{"type":"event", "event":"cc_spawned", "agentId":"worker-1", "sessionId":"abc-123"}
{"type":"event", "event":"process_exit", "agentId":"worker-1", "sessionId":"abc-123", "exitCode":null}
{"type":"event", "event":"session_takeover", "agentId":"worker-1", "sessionId":"abc-123"}

// Agent lifecycle
{"type":"event", "event":"agent_created", "agentId":"worker-1", "agentType":"ephemeral", "repo":"/home/user/project"}
{"type":"event", "event":"agent_destroyed", "agentId":"worker-1"}

// State changes
{"type":"event", "event":"state_changed", "agentId":"worker-1", "field":"model", "value":"opus"}
```

---

## 2. Pull: `tgcc_log` (on-demand transcript access)

Treat the CC transcript as a seekable, filterable log. Each agent has an `EventBuffer` (ring buffer, configurable max size) that stores all CC output events in memory.

### MCP Tool Interface

The `tgcc_log` MCP tool is available to supervisor agents:

```
tgcc_log worker-1                              # last 50 entries
tgcc_log worker-1 --limit 20                   # specific count
tgcc_log worker-1 --grep "error|fail"          # filter by pattern
tgcc_log worker-1 --type tool                  # last tool calls
tgcc_log worker-1 --since 300000               # last 5 minutes (ms)
```

Parameters:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `agentId` | string | required | Worker agent ID |
| `limit` | number | 50 | Max entries to return |
| `grep` | string | none | Regex filter on line content |
| `since` | number | none | Only entries from last N milliseconds |
| `type` | string | none | Filter by entry type |

### Log Line Types

| Type | Source | Content |
|------|--------|---------|
| `text` | CC assistant text output | The response text |
| `thinking` | CC thinking blocks | Thinking content (truncated) |
| `tool` | Tool use + result | Tool name, duration, summary |
| `error` | API errors, crashes | Error message |
| `system` | Init, compact, takeover, high-signal events | System event description |
| `user` | User/supervisor messages sent | The input text + source |

---

## 3. Pull: `tgcc_status` (agent status)

The `tgcc_status` MCP tool returns per-agent status. Omit `agentId` to get all workers.

```jsonc
{
  "agentId": "worker-1",
  "state": "active",
  "repo": "/home/user/project",
  "process": {
    "sessionId": "abc-123",
    "model": "opus"
  },
  "lastActivity": "30s ago",
  "contextPercent": 42
}
```

TGCC tracks cost via `HighSignalDetector.getSessionCost()` and context usage via `message_start` token counts.

---

## 4. CC -> Parent: `notify_parent` MCP Tool

Give CC an explicit way to message the parent agent. This is an MCP tool provided by TGCC to each worker:

```typescript
{
  name: "notify_parent",
  description: "Send a message to the orchestrator/parent that spawned this task.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "Message to send to the parent" },
      priority: { type: "string", enum: ["info", "question", "blocker"], default: "info" }
    },
    required: ["message"]
  }
}
```

### Flow

```
CC uses notify_parent("Build fails, should I install dep X?", priority="question")
  -> MCP bridge receives tool call
  -> TGCC pushes to supervisorEventQueue (native supervisor)
  -> TGCC sends to external supervisor protocol (if connected)
  -> TGCC forwards to supervisor's TG chat (always, for explicit worker messages)
  -> Supervisor sees event, responds via tgcc_send
  -> TGCC forwards to CC stdin
  -> CC continues
```

### When CC Should Use This
- **question** — needs a decision from the parent ("fix A or B?")
- **blocker** — can't proceed without help ("missing credentials")
- **info** — progress update on long tasks ("Phase 1 done, starting Phase 2")

### When CC Should NOT Use This
- Routine progress — handled by pull-based `tgcc_log`
- Completion — handled by `result` event
- Errors — handled by error push notifications

---

## 5. Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| EventBuffer (per-agent ring buffer) | Done | `event-buffer.ts` |
| `tgcc_log` MCP tool | Done | `mcp-server.ts` |
| `tgcc_status` MCP tool | Done | `mcp-server.ts` |
| HighSignalDetector | Done | `high-signal.ts` — all event types implemented |
| Native supervisor event queue | Done | `bridge.ts` — `pushSupervisorEvent()` |
| EventDedup (batching/dedup) | Done | `bridge.ts` |
| Stuck detection | Done | Configurable silence threshold, skips during tool execution |
| Budget tracking | Done | Configurable thresholds, per-session cost accumulation |
| Build/test result detection | Done | Bash exit code + keyword pattern matching |
| Git commit detection | Done | Bash tool with git commit command |
| Context pressure tracking | Done | From `message_start` usage stats |
| Sub-agent spawn detection | Done | Task/dispatch_agent/create_agent/AgentRunner tool use |
| Failure loop detection | Done | 3+ consecutive tool failures |
| Task milestone detection | Done | TodoWrite tool use parsing |
| `notify_parent` MCP tool | Done | Routes to queue + TG chat |
| `supervisor_notify` MCP tool | Done | Desktop/TG notifications |
| TG chat forwarding for tracked workers | Done | `trackedWorkers` set in bridge |
