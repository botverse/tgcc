# SPEC: Split Thinking Blocks Into Their Own Bubble

**Status:** Implemented
**Date:** 2026-03-03  
**Author:** BossBot (Tech Lead)

## Problem

Thinking blocks (`💭`) are currently rendered inline with text and tool segments in the same Telegram message. This causes two issues:

1. **Re-editing noise**: Once thinking is complete and text/tool segments start arriving, every subsequent render re-edits the message containing the thinking blockquote — making it flash/update even though the thinking content hasn't changed.

2. **Wasted space**: Thinking blocks are wrapped in `<blockquote expandable>` and can be large (up to 1024 chars truncated). Keeping them in the same bubble as the response text wastes vertical space and pushes the actual response further down.

3. **Visual confusion**: The thinking and the response look like one unit, but they're conceptually separate — thinking is CC's internal reasoning, the response is the output. Separating them visually reinforces this.

## Current Behavior

```
┌─────────────────────────────────┐
│ 💭 Let me analyze the code...  │  ← expandable blockquote
│    (thinking content)           │
│                                 │
│ Here's what I found:            │  ← text segment
│ The bug is in streaming.ts...   │
│                                 │
│ ⚡ Read streaming.ts            │  ← tool segment
│ ✏️ 0.3s · ✔ streaming.ts       │
│                                 │
│ 📊 1.2k in · 800 out · $0.04   │  ← usage footer
└─────────────────────────────────┘
```

Every tool resolution re-edits this entire message, causing the thinking blockquote to visually refresh.

## Proposed Behavior

```
┌─────────────────────────────────┐
│ 💭 Let me analyze the code...  │  ← own message, sent once, never edited again
│    (thinking content)           │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│ Here's what I found:            │  ← main response bubble
│ The bug is in streaming.ts...   │
│                                 │
│ ⚡ Read streaming.ts            │
│ ✏️ 0.3s · ✔ streaming.ts       │
│                                 │
│ 📊 1.2k in · 800 out · $0.04   │
└─────────────────────────────────┘
```

The thinking block gets its own message that is **sent once and never edited again**. The main response bubble starts fresh and only contains text + tools.

## Design

### Split Trigger

When `content_block_stop` fires for a `thinking` block AND the next `content_block_start` is a different type (text or tool_use), split:

1. **Freeze the thinking segment** — send/edit the current message with just the thinking content
2. **Start a new message** — set `tgMessageId = null` so the next render creates a fresh bubble
3. **Remove the thinking segment from `this.segments`** — the new bubble starts clean

### The `pendingSplit` Flag (streaming.ts:357, 707)

When a thinking block arrives **mid-turn** (i.e., segments already exist from prior text/tool content), the thinking content must not flash briefly inside the existing response bubble before being split out. The `pendingSplit` flag solves this:

1. **Set on creation** (`onContentBlockStart`, streaming.ts:357): When `content_block_start` fires for a `thinking` block and `this.segments.length > 0`, the new thinking segment is created with `pendingSplit: true`. If thinking is the first segment (turn start), `pendingSplit` is `false` — it renders normally in its own bubble from the start.

2. **Checked during render** (`renderHtml`, streaming.ts:707): `renderHtml()` skips any thinking segment where `splitOff` or `pendingSplit` is `true`, returning `''` for it. This means the existing response bubble (MSG_A) is never edited to include thinking content — no visual flash.

3. **Cleared on split**: When `content_block_stop` fires for the thinking block, the split logic removes the segment from `this.segments` entirely and sets `seg.splitOff = true`. At that point `pendingSplit` is no longer relevant since the segment is gone from the array.

```
Timeline (mid-turn thinking):

  segments = [text, tool]          tgMessageId = MSG_A
       │
  cbs: thinking
       pendingSplit = (segments.length > 0) = TRUE
       segments = [text, tool, thinking(pendingSplit)]
       │
  renderHtml() → skips thinking → MSG_A unchanged ✓
       │
  cbs: stop (thinking) → split logic runs
       segments = [] (or post-thinking only)
       tgMessageId = null
```

### Edge Cases

**Multiple thinking blocks**: CC can emit multiple thinking blocks in a single turn (rare but possible). Each gets its own bubble. This is fine — they're naturally sequential.

**Thinking-only response**: If CC responds with only thinking and no text (shouldn't happen, but defensive), the thinking bubble stands alone. No empty response bubble is created.

**Empty thinking**: If the thinking block has no content (just "Processing…"), don't create a separate bubble for it — it's not worth a message. Skip the split and let it render inline. Threshold: only split if `rawText.length > 0`.

**Tool-use loops**: After the first API call's thinking is split out, subsequent iterations in the same turn (tool-use loops) don't have thinking blocks (CC only thinks on the first response). So this only affects the first render cycle.

**Interaction with first-send gate**: The current `firstSendReady` gate delays the first TG message until 200+ chars of text or 2s. The thinking split should bypass this gate — send the thinking bubble immediately (it's expandable/collapsed anyway, so it's not jarring).

### Implementation

In `StreamAccumulator.onContentBlockStop()`, add logic after a thinking block completes:

```typescript
private async onContentBlockStop(event: StreamContentBlockStop): Promise<void> {
    // ... existing tool_use handling ...

    if (this.currentBlockType === 'thinking' && this.currentSegmentIdx >= 0) {
        const seg = this.segments[this.currentSegmentIdx];
        if (seg.type === 'thinking' && seg.rawText.length > 0) {
            // Freeze: send current message with thinking content
            await this.flush();
            
            // Split: remove thinking from segments, start new message
            this.segments = this.segments.filter(s => s !== seg);
            this.tgMessageId = null;
        }
    }

    this.currentBlockType = null;
    this.currentBlockId = null;
    this.currentSegmentIdx = -1;
}
```

**Note**: This is simplified. The actual implementation needs to:
- Chain onto `sendQueue` properly (not bypass it)
- Handle the case where thinking is the ONLY segment (don't leave an empty message)
- Ensure `messageIds` tracks the thinking message for cleanup

### Silent Send

The thinking bubble should be sent **silently** (no push notification). The response bubble is the one that should notify. This matches current behavior since the accumulator uses `silent: true` for all messages.

## Non-Goals

- **Collapsing thinking entirely**: Some users want to hide thinking blocks. That's a separate preference/setting, not this spec.
- **Streaming thinking to a separate message in real-time**: We only split AFTER thinking completes. During streaming, the thinking renders in the current bubble as it does today. The split happens at `content_block_stop`.

## Testing

- Send a message that triggers extended thinking
- Verify thinking appears in its own bubble (expandable blockquote)
- Verify the response text + tools appear in a separate bubble below
- Verify the thinking bubble is NOT re-edited after the response starts
- Verify tool-use loop iterations don't create extra thinking bubbles
- Verify empty thinking blocks don't create empty bubbles
