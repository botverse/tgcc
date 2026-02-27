# Subagent Observability Spec

**Problem:** When OpenClaw spawns a CC task (via TGCC or directly), the caller agent has zero visibility until the task completes or fails. No progress, no errors, no way to check status. But streaming all events into the caller's context would exhaust it — a single CC task can produce hundreds of events.

**Goal:** Find the balance between visibility and context efficiency. Push only critical alerts; let the caller pull details on demand.

## Design Principles

1. **Context is precious** — every line injected into the caller's context costs tokens and attention
2. **Pull > Push** — let the caller decide when and how much to see
3. **Treat transcripts like files** — offset, limit, grep, just like reading code
4. **CC can talk back** — give spawned CC an explicit way to message its parent

---

## 1. Push Notifications (automatic, into caller context)

Only inject into the caller's context when something needs attention:

| Event | When | Context cost |
|-------|------|-------------|
| ✅ Completion | Task finished (result text) | ~100-500 tokens |
| ❌ Error | API error, crash, permission block | ~50-100 tokens |
| ⚠️ Stuck | No progress for N minutes (configurable) | ~30 tokens |
| 💰 Budget | Cost exceeded threshold | ~30 tokens |
| 📋 Task milestone | CC creates/completes a todo item or subtask | ~30-50 tokens |
| 🔨 Build/test result | Build or test pass/fail (highest signal for "is it done?") | ~30-50 tokens |
| 📝 Git commit | CC committed — message is a natural progress summary | ~30-50 tokens |
| 🧠 Context pressure | Context window at 50%, 75%, 90% — quality may degrade | ~20 tokens |
| 🔄 Sub-agent spawn | CC used Task tool to spawn sub-agents (task is bigger than expected) | ~30 tokens |
| 🔁 Failure loop | 3+ consecutive tool failures (CC is stuck) | ~50 tokens |
| 💬 CC message | CC used `notify_parent` MCP tool | Variable |

**Format:** Short, actionable, one message per event:
```
[subagent:sentinella] ❌ API error: rate limited (retry 2/5)
[subagent:sentinella] ⚠️ No progress for 5 minutes (last: editing bridge.ts)
[subagent:sentinella] 💰 $0.50 spent (budget: $1.00)
[subagent:sentinella] 📋 [2/5] Read specs and source files ✅
[subagent:sentinella] 📋 [3/5] Implement ring buffer + get_log
[subagent:sentinella] 🔨 Build passed ✅ (0 errors)
[subagent:sentinella] 🔨 Build failed: 12 errors in bridge.ts
[subagent:sentinella] 📝 Committed: "feat: add event ring buffer and get_log command"
[subagent:sentinella] 🧠 Context at 75% — may compact soon
[subagent:sentinella] 🔄 Spawned 3 sub-agents (team: refactor-squad)
[subagent:sentinella] 🔁 3 consecutive Bash failures — possibly stuck
[subagent:sentinella] 💬 "Build fails — missing dep X. Install it?"
```

### TGCC Implementation

TGCC tracks these conditions per-process and emits supervisor events:

```jsonc
// Error event (already exists, extend with detail)
{"type":"event", "event":"api_error", "agentId":"sentinella", "message":"rate limited", "retry":"2/5"}

// Task milestone (from TodoWrite tool use)
{"type":"event", "event":"task_milestone", "agentId":"sentinella", "task":"Read specs and source files", "status":"completed", "progress":"2/5"}

// Build/test result (detect from Bash tool output: exit code + "error"/"passed"/"failed" keywords)
{"type":"event", "event":"build_result", "agentId":"sentinella", "command":"npm run build", "passed":true, "errors":0, "summary":"Build passed"}
{"type":"event", "event":"build_result", "agentId":"sentinella", "command":"npm run build", "passed":false, "errors":12, "summary":"12 errors in bridge.ts"}

// Git commit (detect from Bash tool: `git commit` command with exit 0)
{"type":"event", "event":"git_commit", "agentId":"sentinella", "message":"feat: add event ring buffer"}

// Context pressure (from stream_event usage stats — track cumulative)
{"type":"event", "event":"context_pressure", "agentId":"sentinella", "percent":75, "tokens":150000}

// Sub-agent spawn (detect from Task/dispatch_agent tool use)
{"type":"event", "event":"subagent_spawn", "agentId":"sentinella", "count":3, "teamName":"refactor-squad"}

// Failure loop (track consecutive tool failures — 3+ triggers alert)
{"type":"event", "event":"failure_loop", "agentId":"sentinella", "consecutiveFailures":3, "lastTool":"Bash", "lastError":"exit code 1"}

// Stuck (no output for N minutes)
{"type":"event", "event":"stuck", "agentId":"sentinella", "silentMs":300000, "lastActivity":"editing bridge.ts"}

// Budget event (new)  
{"type":"event", "event":"budget_alert", "agentId":"sentinella", "costUsd":0.50, "budgetUsd":1.00}

// CC notify_parent (new, via MCP tool → supervisor event)
{"type":"event", "event":"cc_message", "agentId":"sentinella", "text":"Build fails — missing dep X. Install it?"}
```

### OpenClaw Implementation

`TgccSupervisorClient` receives events → injects as system messages into the requester's session.

---

## 2. Pull: `subagents log` (on-demand transcript access)

Treat the CC transcript as a seekable, filterable file.

### Tool Interface (OpenClaw)

```
subagents log <target>                              # last 50 lines
subagents log <target> --offset 100 --limit 20      # specific range  
subagents log <target> --grep "error|fail"           # filter by pattern
subagents log <target> --grep "tool_use" --limit 10  # last 10 tool calls
subagents log <target> --since 5m                    # last 5 minutes
subagents log <target> --summary                     # compressed summary (cheap model)
```

Parameters:
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `target` | string | required | Subagent label or run ID |
| `offset` | number | 0 | Line offset from start (0-indexed) |
| `limit` | number | 50 | Max lines to return |
| `grep` | string | none | Regex filter on line content |
| `since` | string | none | Time filter (e.g. "5m", "1h") |
| `summary` | boolean | false | Return compressed summary instead of raw lines |
| `type` | string | none | Filter by event type: "text", "tool", "error", "thinking" |

### TGCC Implementation: `get_log` command

TGCC buffers CC output events in memory (ring buffer, configurable max size). Supervisor can query:

```jsonc
// Request
{
  "type": "command",
  "requestId": "...",
  "action": "get_log",
  "params": {
    "agentId": "sentinella",
    "offset": 0,          // optional
    "limit": 50,           // optional
    "grep": "error|fail",  // optional, regex
    "since": 300000,       // optional, ms ago
    "type": "tool"         // optional, event type filter
  }
}

// Response
{
  "type": "response",
  "requestId": "...",
  "result": {
    "totalLines": 247,
    "returnedLines": 12,
    "offset": 235,
    "lines": [
      {"ts": 1772211918087, "type": "tool", "text": "✅ Bash (2.1s)\ncd /home/fonz/Botverse/sentinella && git log --oneline -3"},
      {"ts": 1772211918282, "type": "text", "text": "Here are the last 3 commits:"},
      ...
    ]
  }
}
```

### Log Line Types

| Type | Source | Content |
|------|--------|---------|
| `text` | CC assistant text output | The response text |
| `thinking` | CC thinking blocks | Thinking content (truncated) |
| `tool` | Tool use + result | Tool name, duration, summary |
| `error` | API errors, crashes | Error message |
| `system` | Init, compact, takeover | System event description |
| `user` | User/supervisor messages sent | The input text + source |

---

## 3. Pull: `subagents status` (enhanced)

Already partially exists. Enhance with more detail:

```jsonc
// subagents status sentinella
{
  "agentId": "sentinella",
  "state": "active",
  "runtime": "12m",
  "sessionId": "abc-123",
  "costUsd": 0.34,
  "tokensIn": 45000,
  "tokensOut": 12000,
  "toolsUsed": 8,
  "lastActivity": "editing src/bridge.ts",
  "lastActivityAge": "30s ago"
}
```

### TGCC Implementation

Extend `status` response with per-process stats. TGCC already tracks cost via `result` events — accumulate per-process.

---

## 4. CC → Parent: `notify_parent` MCP Tool

Give CC an explicit way to message the parent agent. This is an MCP tool provided by TGCC's MCP bridge:

```typescript
// MCP tool definition
{
  name: "notify_parent",
  description: "Send a message to the orchestrator/parent that spawned this task. Use for: asking questions, reporting blockers, progress updates on long tasks, or when you need a decision.",
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
  → MCP bridge receives tool call
  → TGCC emits supervisor event: {event: "cc_message", agentId, text, priority}
  → OpenClaw receives event → injects into caller's context
  → Caller responds via subagents steer
  → TGCC forwards to CC stdin
  → CC continues
```

### When CC Should Use This
- **question** — needs a decision from the parent ("fix A or B?")
- **blocker** — can't proceed without help ("missing credentials")
- **info** — progress update on long tasks ("Phase 1 done, starting Phase 2")

### When CC Should NOT Use This
- Routine progress — handled by pull-based `subagents log`
- Completion — handled by `result` event
- Errors — handled by error push notifications

---

## 5. Implementation Phases

### Phase A: Pull basics
- TGCC: ring buffer for CC events, `get_log` command with offset/limit/grep
- OpenClaw: `subagents log` tool with params, `subagents status` enhancement

### Phase B: Push alerts
- TGCC: stuck detection, budget tracking, emit alert events
- OpenClaw: event handlers for alerts, inject as system messages

### Phase C: CC → Parent
- TGCC: `notify_parent` MCP tool, forward as supervisor event
- OpenClaw: `cc_message` event handler, inject into caller context

---

## 6. Inventory

### TGCC
| What | Phase |
|------|-------|
| Event ring buffer (per-process, configurable max) | A |
| `get_log` supervisor command | A |
| Enhanced `status` with per-process stats | A |
| Stuck detection (configurable silence threshold) | B |
| Budget tracking per-process | B |
| `stuck` and `budget_alert` supervisor events | B |
| Build/test result detection (Bash exit code + keyword parsing) | B |
| Git commit detection (git commit tool use) | B |
| Context pressure tracking (from usage stats) | B |
| Sub-agent spawn detection (Task/dispatch_agent tool use) | B |
| Failure loop detection (3+ consecutive tool failures) | B |
| Task milestone detection (TodoWrite tool use) | B |
| `notify_parent` MCP tool | C |
| `cc_message` supervisor event | C |

### OpenClaw
| What | Phase |
|------|-------|
| `subagents log` tool (offset/limit/grep/since/type) | A |
| Enhanced `subagents status` display | A |
| Error/stuck/budget event handlers → system message injection | B |
| `cc_message` event handler → system message injection | C |
