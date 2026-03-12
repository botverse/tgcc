# Sub-Agent TG Events & Supervisor Visibility

## Problem

When a worker (e.g. linds) spawns sub-agents via CC's `Task` tool:

1. **No tool call info in TG** — `task_progress` events fire after each tool call inside the sub-agent
   and carry `last_tool_name`, but `formatProgressLine()` only uses `lastToolName` for emoji selection,
   never renders it as text. If `description` is also empty, the function returns `null` → nothing shown.
2. **Supervisor is blind** — `subagent_spawn` routing via `ROUTED_EVENTS` in `bridge.ts:256` (now included; was previously missing).

---

## Current Signal Inventory

What TGCC receives from CC about a running sub-agent:

| Event | Fires when | Contains |
|-------|-----------|---------|
| `content_block_start` (tool_use) | Tool block opens | `tool_use_id`, `name` (`Task`) |
| `tool_use_result` | Sub-agent spawned | spawn confirmation, agent name |
| `task_started` | Sub-agent begins | `tool_use_id`, `description` |
| `task_progress` | After each tool call inside sub-agent | `last_tool_name`, `description` (often empty), `usage.duration_ms`, `usage.tool_uses` |
| `task_completed` | Sub-agent finishes | `tool_use_id` |

**Cadence**: one `task_progress` per tool call inside the sub-agent. Sparse updates are expected
and acceptable — we just need those events to actually render something useful.

---

## Goals

### TG display (worker's Telegram chat)

Current (nothing appears between dispatched and completed because description is empty):
```
🔄 Search for comidas group — dispatched
✅ Search for comidas group — Done (2m 2s)
```

Target (one line per task_progress, showing the tool name):
```
🔄 Search for comidas group — dispatched
📋 mcp__linds-os__search_contacts
📋 mcp__linds-os__search_memories
✅ Search for comidas group — Done (2m 2s)
```

### Supervisor (CC UI worker events)

Current:
```
[linds] ✅ Turn complete · $3.38
```

Target:
```
[linds] 🔄 Spawned sub-agent: "Search for comidas group"
[linds] ✅ Sub-agents done (1/1) · 2m 2s
[linds] ✅ Turn complete · $3.38
```

---

## Changes

### 1. Fix `formatProgressLine` — show tool name

`streaming.ts:1292` — **DONE**: now falls through to `lastToolName` when `description` is empty:

```ts
// Current implementation (streaming.ts:1292)
export function formatProgressLine(description: string, lastToolName?: string): string | null {
  const desc = description?.trim();
  const tool = lastToolName?.trim() ?? '';
  if (!desc && !tool) return null;

  // emoji selection based on tool + description
  let emoji = '📋';
  if (toolLower === 'bash' && /build|compile|…/.test(lower)) emoji = '🔨';
  // …

  // Tool name is the primary signal; description is secondary context
  const parts: string[] = [];
  if (tool) parts.push(tool);
  if (desc && desc !== tool) parts.push(desc);
  const display = parts.join(' · ');

  const truncated = display.length > 70 ? display.slice(0, 70) + '…' : display;
  return `${emoji} ${escapeHtml(truncated)}`;
}
```

This also affects the `appendSubAgentProgress` path in `StreamAccumulator` (`streaming.ts:688`, same function).

### 2. Route `subagent_spawn` to supervisor — DONE

`bridge.ts:256` — `subagent_spawn` is now included in `ROUTED_EVENTS`:
```ts
const ROUTED_EVENTS = new Set([
  'failure_loop', 'stuck', 'task_milestone', 'build_result', 'git_commit',
  'subagent_spawn',
]);
```

Update `HighSignalDetector.eventSummary` for `subagent_spawn` to include the label if available
(currently just shows toolName + count).

### 3. `subagent_all_done` event

When all dispatched sub-agents complete, `SubAgentTracker` calls back via a new
`onAllDone(stats: { count: number, elapsedMs: number })` option. Bridge wires this to
`pushSupervisorEvent`:

```
[linds] ✅ Sub-agents done (1/1) · 2m 2s
```

Add to `HighSignalDetector.eventEmoji` and `eventSummary`:
```
subagent_all_done → ✅  "Sub-agents done (<N>/<N>) · <elapsed>"
```

Or: SubAgentTracker emits directly via a callback (simpler — avoids adding a new HighSignal event).

---

## Non-goals

- Heartbeat timer (no timers — sparse updates are fine as long as tool names show up)
- Real-time sub-agent stream relay (impossible without CC exposing per-tool events from sub-agents)
- Per-sub-agent Telegram messages

---

## Implementation order

1. ~~**Fix `formatProgressLine`**~~ — DONE (`streaming.ts:1292`). Tool name is now primary signal.
2. ~~**`subagent_spawn` in ROUTED_EVENTS**~~ — DONE (`bridge.ts:256`).
3. **`subagent_all_done` callback** — SubAgentTracker callback + bridge routing. Still TODO.
