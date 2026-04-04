# SPEC: Replace Segment Index with Direct Object Reference

**Status:** Draft  
**Date:** 2026-03-03  
**Author:** BossBot (Tech Lead)  
**Priority:** Critical (causes crashes)

## Problem

`StreamAccumulator` tracks the currently-building content block via `currentSegmentIdx: number` — an index into `this.segments[]`. Multiple code paths reassign `this.segments` (replacing the array), which invalidates any index:

| Site | Code | When | Sync? |
|------|------|------|-------|
| Thinking split (mid-turn) | `this.segments = this.segments.slice(thinkingIdx + 1)` | `onContentBlockStop` | ✓ sync |
| Thinking split (first) | `this.segments = this.segments.slice(1)` | `onContentBlockStop` | ✓ sync |
| `splitMessage()` | `this.segments = this.segments.slice(splitSegIdx)` | Inside `sendQueue.then()` | ✗ **async** |
| `forceSplitText()` | `this.segments = [newSeg]` | `await` in delta handler | ✗ **async** |
| `reset()` | `this.segments = []` | Turn boundary | ✓ sync |

When `splitMessage()` or `forceSplitText()` runs async and reassigns `this.segments`, `currentSegmentIdx` still points at the old position. The next `onContentBlockDelta` reads `this.segments[staleIndex]` → `undefined` → `Cannot read properties of undefined (reading 'rawText')` → wall of errors, frozen bubble.

## Solution

Replace `currentSegmentIdx: number` with `currentSegment: InternalSegment | null`.

A direct object reference survives array reassignment — the segment object itself stays alive as long as we hold a reference, even if it's been removed from `this.segments`.

### Changes

#### 1. Field change

```typescript
// Before
private currentSegmentIdx = -1;

// After
private currentSegment: InternalSegment | null = null;
```

#### 2. `onContentBlockStart` — set reference instead of index

```typescript
// Before
this.segments.push(seg);
this.currentSegmentIdx = this.segments.length - 1;

// After
this.segments.push(seg);
this.currentSegment = seg;
```

#### 3. `onContentBlockDelta` — use reference directly

```typescript
// Before
if (delta?.type === 'text_delta' && this.currentSegmentIdx >= 0) {
    const seg = this.segments[this.currentSegmentIdx] as ...;
    seg.rawText += delta.text;

// After
if (delta?.type === 'text_delta' && this.currentSegment?.type === 'text') {
    this.currentSegment.rawText += delta.text;
    this.currentSegment.content = renderSegment(this.currentSegment);
```

The type check (`?.type === 'text'`) replaces both the index bounds check AND the type cast. If the segment was removed from the array or the type doesn't match, we silently skip.

Same pattern for thinking deltas and tool_use deltas.

#### 4. `onContentBlockStop` — snapshot and clear reference

```typescript
// Before
const blockType = this.currentBlockType;
const blockId = this.currentBlockId;
const segIdx = this.currentSegmentIdx;
this.currentBlockType = null;
this.currentBlockId = null;
this.currentSegmentIdx = -1;

// After
const blockType = this.currentBlockType;
const blockId = this.currentBlockId;
const seg = this.currentSegment;
this.currentBlockType = null;
this.currentBlockId = null;
this.currentSegment = null;
```

Then use `seg` directly instead of `this.segments[segIdx]`. No index lookups needed.

For the thinking split, `thinkingIdx` (the index of the thinking segment in the array) is needed to know where to split. Compute it on the fly:

```typescript
const thinkingIdx = this.segments.indexOf(seg);
if (thinkingIdx < 0) return; // segment was already removed (defensive)
```

#### 5. `softReset()` and `reset()` — clear reference

```typescript
// softReset
this.currentSegment = null;

// reset
this.currentSegment = null;
```

#### 6. `forceSplitText()` — update reference

```typescript
// forceSplitText creates a new segment for the remainder
const newSeg = { type: 'text', rawText: remainder, content: '' };
this.segments = [newSeg];
this.currentSegment = newSeg;  // update reference to new segment
```

#### 7. `splitMessage()` — no changes needed

`splitMessage` reassigns `this.segments` but never touches `currentSegment`. The reference stays valid because:
- If the current segment is in the first half (already sent), it's no longer in `this.segments` but we still hold the reference — deltas just update an orphaned object (harmless, gets GC'd when block stops)
- If the current segment is in the second half, it's still in `this.segments` — reference is valid

### Bonus: Remove all defensive guards

Once the refactor is done, remove the `if (!seg) return` guards added as band-aids. The direct reference pattern makes them unnecessary.

### Bonus: `tgMessageId` capture pattern

Extend the capture-at-queue-time pattern to ALL sites that queue `_doSendOrEdit`, not just `flushRender` and `finalize`. This prevents the other class of race (wrong message getting edited). Specifically:
- `splitMessage()` — first call should capture, second creates new (already correct)
- `forceSplitText()` — should capture
- `thinking split` — already captures (done in earlier fix)

## Testing

1. Send a message that triggers extended thinking → verify thinking splits into own bubble
2. Send rapid messages during tool-use loops → verify no crashes
3. Send a very long message that triggers `splitMessage` during streaming → verify no crashes
4. Check tmux logs for zero `rawText` errors over a 10-minute session

## Risk

Low. This is a mechanical refactor — replacing index lookups with direct references. The behavior is identical; the only difference is resilience to array reassignment.
