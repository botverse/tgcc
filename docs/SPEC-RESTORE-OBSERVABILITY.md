# SPEC: Restore Full Observability to OpenClaw Plugin

**Status:** Draft
**Date:** 2026-03-03
**Author:** BossBot (Tech Lead)

## Problem

When TGCC observability was built into the OpenClaw core (`feat/tgcc-supervisor` branch), the main agent had **real-time, push-based visibility** into all CC sessions. Every meaningful event — builds, commits, milestones, failures, context pressure — was injected into the agent's session as a `[System Event]`, waking it up automatically.

When we moved to the **plugin architecture**, most of the event detection and routing infrastructure survived (it's all there in `high-signal.ts`, `event-buffer.ts`, `client.ts`, `events.ts`). But the **event routing policy** got conservative — only `stuck` and `failure_loop` events wake the agent. Everything else gets logged to `recentEvents` and is only visible when the agent explicitly calls `tgcc_status`.

**Result:** The agent lost its ability to passively monitor what CC sessions are doing. It can't tell Fnz what an agent is working on without manually reading JSONL files.

## What Exists Today

### TGCC Side (fully implemented ✅)
- `high-signal.ts` — detects all high-signal events from CC stream:
  - `build_result`, `git_commit`, `context_pressure`, `failure_loop`, `stuck`, `task_milestone`, `subagent_spawn`, `budget_alert`
- `event-buffer.ts` — ring buffer per agent, supports offset/limit/grep/since/type queries
- `ctl-server.ts` — emits events over supervisor socket, handles `get_log` command

### Plugin Side (partially implemented)
- `client.ts` — receives all events, has `getLog()` method ✅
- `events.ts` — formats all events, stores in `recentEvents` ✅
  - **But:** only wakes agent for `stuck` + `failure_loop` ❌
  - **But:** no `tgcc_log` tool wraps the `getLog()` client method ❌

### What the old OpenClaw branch did differently
Every observability event → `callGateway({ method: "agent", message: "[System Event] ..." })` → agent wakes up and sees it in context.

## Changes Required

### 1. Expand wake-agent event set (events.ts)

Current:
```typescript
const wakeObsEvents = new Set(["tgcc:stuck", "tgcc:failure_loop"]);
```

Proposed — wake for **all actionable events**:
```typescript
const wakeObsEvents = new Set([
  "tgcc:stuck",
  "tgcc:failure_loop",
  "tgcc:build_result",     // agent needs to know if build passed/failed
  "tgcc:git_commit",       // natural progress marker
  "tgcc:task_milestone",   // progress tracking
  "tgcc:context_pressure", // quality may degrade, agent might need to act
  "tgcc:cc_message",       // CC explicitly asked to talk to parent (already wakes)
  "tgcc:budget_alert",     // cost control
]);
```

**Excluded from wake** (too noisy, pull-only):
- `subagent_spawn` — informational, not actionable

#### Filtering to avoid noise

Not every build or commit needs to wake the agent. Add a **debounce/dedup layer**:

```typescript
// Don't wake for build_result if it passed and last build also passed (within 60s)
// Don't wake for context_pressure if we already woke for the same threshold
// Don't wake for git_commit if last commit was <30s ago (batch commits)
```

This is already partially handled by `HighSignalDetector` (context thresholds only fire once per threshold), but build/commit debouncing needs to be added in the plugin event handler.

### 2. Add `tgcc_log` tool

The `getLog()` client method exists but no tool exposes it. Add `plugin/src/tools/tgcc-log.ts`:

```typescript
// Tool: tgcc_log
// Description: "View the event log for a TGCC agent's CC session.
//   Shows build results, commits, milestones, errors, and assistant output.
//   Use to check what an agent is working on without waking it."
//
// Parameters:
//   agentId: string (required) — which agent
//   offset: number (optional) — start from line N
//   limit: number (optional, default 30) — max lines
//   grep: string (optional) — regex filter
//   since: number (optional) — only events from last N milliseconds
//   type: string (optional) — filter: "text" | "tool" | "system" | "error" | "user"
```

Register in the plugin's tool list alongside `tgcc_spawn`, `tgcc_send`, `tgcc_status`, `tgcc_kill`.

### 3. Enhance `tgcc_status` output

Currently `tgcc_status` returns `recentEvents` as flat summaries. Enhance with:

- **Per-agent last activity** — timestamp + description of last meaningful event
- **Per-agent cost accumulator** — total spend in current/recent session
- **Per-agent context usage** — last known context % (from `context_pressure` events)

These are already tracked by `HighSignalDetector` state — just need to surface them through the status response.

### 4. Update SKILL.md

Update `skills/tgcc-agents/SKILL.md` to document:
- `tgcc_log` tool usage
- Which events auto-wake the agent
- When to use `tgcc_log` vs `tgcc_status` vs reading JSONL directly

## Non-Goals

- **MCP `notify_parent` tool** — already specced in `SPEC-SUBAGENT-OBSERVABILITY.md`, separate work
- **Changing TGCC's event detection** — `high-signal.ts` is solid, no changes needed
- **Changing the supervisor wire protocol** — all events already flow correctly

## Implementation Order

1. **`tgcc_log` tool** — immediate value, agent can pull logs right now
2. **Expand wake events** — with debounce layer
3. **Enhance `tgcc_status`** — per-agent enrichment
4. **Update skill docs** — after tools are working

## Testing

- Spawn a CC task on any agent
- Verify `tgcc_log <agentId>` shows real-time log entries
- Verify build/commit/milestone events wake the main agent
- Verify debounce prevents noise (rapid commits, consecutive passing builds)
- Verify `tgcc_status` shows per-agent activity/cost/context info
