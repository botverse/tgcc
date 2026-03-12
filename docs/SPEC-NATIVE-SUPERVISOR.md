# Native Supervisor — Spec

## Overview

Today the supervisor role is filled by OpenClaw via the TGCC plugin (Unix socket + MCP tools). This spec describes moving that role natively into TGCC itself: one agent is designated **supervisor**, the rest are **workers**. The supervisor is a regular CC instance with elevated privileges — it receives automatic worker event notifications and gets additional MCP tools to manage workers.

---

## Goals

- First agent created on install is automatically the supervisor
- Supervisor is reassignable via config
- Workers are invisible to each other; only the supervisor sees cross-agent events
- No dependency on OpenClaw or the plugin for basic supervisor functionality
- The plugin can still coexist (OpenClaw as external supervisor remains supported)

---

## Config

Add a top-level `supervisor` field to `tgcc.json`:

```json
{
  "supervisor": "main",
  "agents": [
    { "id": "main" },
    { "id": "sentinella" },
    { "id": "linds" }
  ]
}
```

- Defaults to the first agent in the `agents` array on a fresh install
- Can be set to any valid `agentId`
- Set to `null` to disable native supervisor (e.g. when using OpenClaw plugin exclusively)
- Only one supervisor at a time

---

## Worker Event Routing

When a worker agent fires a high-signal event, the bridge injects a system message into the supervisor's CC process. If the supervisor has no active CC process, the message is queued and delivered on next turn start.

### Message format

Injected as a user message (same mechanism as `notify_parent`):

```
[Worker: sentinella] <emoji> <summary>
```

Examples:
```
[Worker: sentinella] ✅ Turn complete · $0.43 · 34s
[Worker: sentinella] 📋 [2/5] Implement auth middleware (in_progress)
[Worker: sentinella] 🔨 Build failed: 3 errors
[Worker: sentinella] 📝 Committed: "fix streaming render"
[Worker: sentinella] 🔁 3 consecutive failures — possibly stuck
[Worker: sentinella] ⚠️ No output for 5min
[Worker: sentinella] 🧠 Context at 90%
[Worker: sentinella] ❌ API error: overloaded
[Worker: sentinella] 💀 Process exited unexpectedly
```

### Events routed (priority tiers)

**Tier 1 — Always route:**
| Source | Event | Condition |
|--------|-------|-----------|
| `handleResult` | Turn complete | Every turn end |
| `HighSignalDetector` | `failure_loop` | 3+ consecutive failures |
| `HighSignalDetector` | `stuck` | No output for 5min |
| bridge `error` | API error / crash | `is_error: true` result or unhandled error |
| bridge `exit` | Process exited | Unexpected exit only (not normal idle exit) |

**Tier 2 — Route by default, configurable off:**
| Source | Event | Condition |
|--------|-------|-----------|
| `HighSignalDetector` | `task_milestone` | Every TodoWrite |
| `HighSignalDetector` | `build_result` | Every build/test run |
| `HighSignalDetector` | `git_commit` | Every commit |

**Tier 3 — Off by default, configurable on:**
| Source | Event | Condition |
|--------|-------|-----------|
| `HighSignalDetector` | `context_pressure` | At 90% threshold only |
| `HighSignalDetector` | `subagent_spawn` | First spawn per turn |

**Never routed** (too noisy / low value):
- `init` (session started)
- `context_pressure` at 50/75%
- compaction events
- `subagent_spawn` beyond first per turn

### Supervisor-to-self events

The supervisor does NOT receive events about itself (no self-routing). The supervisor agent is treated as a regular agent for its own turn rendering.

### Queueing when supervisor is idle

If the supervisor's CC process is idle (no active turn), messages are queued in an in-memory ring buffer (max 20 messages). When the supervisor next starts a turn, queued messages are prepended as a batch:

```
[Worker events since last session]
[Worker: sentinella] ✅ Turn complete · $0.43 · 34s
[Worker: linds] 📝 Committed: "add dark mode"
[Worker: sentinella] 🔨 Build failed: 2 errors
```

If the queue overflows (>20), oldest entries are dropped and a count is noted.

---

## Supervisor MCP Tools

The supervisor agent gets additional MCP tools in its CC instance. Workers do not have these tools.

These are served by the bridge's existing MCP server (same process, same Unix socket infrastructure).

### `tgcc_status([agentId])`

Returns status of all workers (or one specific worker).

```
Output per agent:
- state: idle | active
- contextPercent: number
- lastActivity: { ts, summary }
- currentSession: { id, title, age }
```

### `tgcc_send(agentId, text, [options])`

Send a message to a worker. If the worker has no active CC process, starts one.

Options:
- `newSession: boolean` — clear session before sending
- `sessionId: string` — resume specific session
- `followUp: boolean` — only send if worker CC is currently active (no spawn)

### `tgcc_kill(agentId)`

Kill the worker's CC process. Worker agent registration is preserved.

### `tgcc_log(agentId, [options])`

Read the worker's event buffer (ring buffer, last N entries).

Options:
- `limit: number` — max entries (default 50)
- `since: number` — ms ago (e.g. 300000 = last 5min)
- `type: string` — filter by entry type (text | tool | system | error)

### `tgcc_session(agentId, action, [options])`

Session lifecycle operations without sending a message.

Actions: `list`, `new`, `continue`, `resume`, `cancel`, `compact`, `set_model`, `set_repo`, `set_permissions`

---

## Implementation Plan

### Phase 1 — Config + routing scaffolding

1. Add `supervisor` field to config schema (`src/config.ts`)
2. In `Bridge`, resolve supervisor agent on startup; expose `getSupervisorAgentId()` helper
3. Add `SupervisorQueue` — in-memory ring buffer (max 20) per supervisor, drains on turn start
4. In `HighSignalDetector` callbacks: if source agent ≠ supervisor, route to `SupervisorQueue`
5. In `handleResult`: route turn-complete to `SupervisorQueue`
6. In bridge `error`/`exit` handlers: route unexpected failures to `SupervisorQueue`
7. On `message_start` for supervisor agent: drain queue and prepend as system message

### Phase 2 — MCP tools

8. In `cc-process.ts` MCP config generation: if agent is supervisor, append 5 extra tools
9. In bridge MCP server handler (`handleSupervisorCommand` or new `handleMcpTool`): implement `tgcc_status`, `tgcc_send`, `tgcc_kill`, `tgcc_log`, `tgcc_session`

### Phase 3 — Polish

10. Per-agent routing config (allow workers to opt out of certain event tiers)
11. Queue overflow handling + delivery receipt logging
12. Graceful fallback: if supervisor CC is killed, queue is preserved until it restarts

---

## What this replaces from the plugin

| Plugin capability | Native equivalent |
|-------------------|-------------------|
| Unix socket + register_supervisor | Bridge internal routing |
| `tgcc_spawn/send/status/kill/log` MCP tools | Same tools, served by bridge MCP server |
| Event → wake OpenClaw session | Event → inject into supervisor CC queue |
| Permission Telegram buttons | Already in bridge (unchanged) |
| Observability → Telegram | Already in bridge (unchanged) |
| `exec` reverse command | Already exists (`supervisor_exec`) |
| Ring buffers (results, events, permissions) | SupervisorQueue + existing EventBuffer |
| Agent cache | Bridge's existing `agents` Map |

The plugin remains supported for OpenClaw users. When both native supervisor and plugin are active, events are routed to both (plugin still receives via `emitSupervisorEvent`).

---

## Open Questions

1. **Delivery guarantee**: Should queued messages survive a TGCC restart? (Probably not for v1 — in-memory only.)
2. **Tier 2 configurability**: Per-agent or global? Suggest global flag in config for v1.
3. **Supervisor's own events**: Should the supervisor see its own `build_result` / `git_commit`? (No — it would be self-referential noise.)
4. **Multiple supervisors**: Out of scope for v1.
5. **Worker can query supervisor**: Out of scope — `notify_parent` already covers the reverse direction.
