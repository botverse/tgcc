# Single Bubble v2 — Streaming Accumulator Rewrite

## Goal
One TG message per CC turn. All content in stream order. System elements (thinking, tools, sub-agents) wrapped in blockquotes inline with text.

## CC Event Model

A **turn** = everything from first `message_start` until `result` event.

Within a turn, CC may make multiple API calls (tool-use loops):
```
message_start → [blocks] → message_stop → message_start → [blocks] → message_stop → ... → result
```

Each API call contains ordered **content blocks**:
- `thinking` — private reasoning (expandable blockquote)
- `text` — visible response (plain text)
- `tool_use` — tool call with name + JSON input (blockquote indicator)

Blocks within a message are strictly ordered by `index`. Across API calls within a turn, order is preserved by arrival time.

## Rendering Rules

### One bubble per turn
- First content → `sendMessage` (creates the bubble)
- All subsequent content → `editMessage` (same bubble)
- `result` event → finalize (append usage footer, stop editing)
- Next turn's `message_start` (after `result`) → new `sendMessage`

### Content in stream order
Append segments to an ordered list. Render in order. Never reorder.

### Segment types and rendering

| Segment | Render |
|---------|--------|
| `thinking` | `<blockquote expandable>💭 {content}</blockquote>` |
| `text` | Plain text (HTML-escaped, no wrapping) |
| `tool_use` (pending) | `<blockquote>⚡ {toolName}… · <code>{inputPreview}</code></blockquote>` |
| `tool_use` (resolved) | `<blockquote>✅ {toolName} ({elapsed}) · <code>{summary}</code></blockquote>` |
| `tool_use` (error) | `<blockquote>❌ {toolName} ({elapsed})</blockquote>` |
| `sub-agent` (running) | `<blockquote>🤖 {label} — Working…</blockquote>` |
| `sub-agent` (dispatched) | `<blockquote>🤖 {label} — Waiting for results…</blockquote>` |
| `sub-agent` (completed) | `<blockquote>🤖 {label} — ✅ Done</blockquote>` |
| `supervisor` | `<blockquote>🦞 {message}</blockquote>` |
| `usage` | `<blockquote>📊 {in} in · {out} out · ${cost} · {ctx%}</blockquote>` |

### Sub-agents
Sub-agents are just `tool_use` blocks with name ∈ {Task, dispatch_agent, create_agent, AgentRunner}. They appear in stream order like any other tool. The only difference is lifecycle: they stay "dispatched" (waiting) until a result comes back, which can take minutes.

### Supervisor messages
Appended to the segment list when received via `addSupervisorMessage()`. Rendered in order with everything else.

### Message splitting
If the buffer exceeds Telegram's limit (~4096 chars), split at a natural boundary. First part gets finalized, remainder starts a new TG message. System context stays with whichever message it appeared in (no moving things around).

### Push notifications
Delay first `sendMessage` until either:
- 200+ chars accumulated, OR
- 2 seconds elapsed since turn start, OR
- Turn finalized

This ensures push notification preview shows meaningful text.

## Architecture

### Segment buffer (ordered FIFO)
```typescript
type SegmentType = 'thinking' | 'text' | 'tool' | 'subagent' | 'supervisor' | 'usage';

interface Segment {
  type: SegmentType;
  id?: string;        // block ID for tools/sub-agents (for updates)
  content: string;    // current rendered HTML
}
```

### Single publisher
One method renders all segments in order → one HTML string → sendOrEdit.

```typescript
renderHtml(): string {
  return this.segments.map(s => s.content).join('\n');
}
```

### Event flow
```
stream event → identify segment type → append or update segment → renderHtml() → sendOrEdit()
```

- `content_block_start` (thinking) → append thinking segment
- `content_block_delta` (thinking_delta) → update last thinking segment
- `content_block_start` (text) → append text segment
- `content_block_delta` (text_delta) → update last text segment
- `content_block_start` (tool_use) → append tool segment (pending)
- `content_block_delta` (input_json_delta) → update tool segment preview
- tool result → update tool segment (resolved/error)
- `result` → append usage segment, finalize

### State
- `segments: Segment[]` — ordered content
- `tgMessageId: number | null` — current bubble
- `finished: boolean` — turn complete
- `turnStartedAt: number` — for first-send deferral

### Reset
- `softReset()` — clear per-API-call transient state only (currentBlockType, timers). Segments and tgMessageId persist.
- `reset()` — clear everything. New bubble on next content.

## What this replaces
- Separate `thinkingMessageId` / `thinkingBuffer` → thinking segment in FIFO
- Separate `consolidatedToolMsgId` / `toolMessages` → tool segments in FIFO
- Separate `SubAgentTracker` with own sender → sub-agent segments in FIFO
- Separate supervisor `sendText()` → supervisor segments in FIFO
- `buildCombinedHtml()` with hardcoded section order → `renderHtml()` from ordered segments

## Sub-Agent Lifecycle

Sub-agents are tool_use blocks with name ∈ {Task, dispatch_agent, create_agent, AgentRunner}.

### Phase 1 — Dispatch (in-stream)
Normal tool_use flow. Appears in FIFO as a tool segment:
```
⚡ Task… · "Fix the bug"        ← content_block_start
🤖 bugfixer — Dispatched        ← content_block_stop (status: dispatched)
```

### Phase 2 — Spawn confirmation (tool_result) 
CC gets the tool_result with spawn confirmation. Updates the existing segment in the current bubble:
```
🤖 bugfixer — Waiting for results…
```

### Phase 3 — Turn ends, sub-agent still running
`result` event fires → current bubble finalized with usage footer. Done.

**New bubble** for sub-agent status updates. The tracker creates a standalone status bubble:
```
🤖 bugfixer — Working (2m 15s)…
```
This bubble gets edited as status changes (progress events, elapsed time). When the sub-agent completes (via mailbox or next tool_result), final edit:
```
🤖 bugfixer — ✅ Done (3m 42s)
```

### Phase 4 — All sub-agents done
`onAllReported` callback → bridge prompts CC to continue → new turn → new bubble.

### Key rule
**A finalized bubble is never edited again.** Once `result` fires and usage footer is appended, that bubble is sealed. All subsequent updates (sub-agent status, mailbox results) go to a new bubble.
