# SPEC: Thinking Bubble Deduplication & Re-Edit Prevention

**Status:** Implemented
**Date:** 2026-03-03
**Author:** Claude (agent)
**Related:** `SPEC-THINKING-BUBBLE-SPLIT.md`

---

## Problem

After implementing the thinking bubble split (see `SPEC-THINKING-BUBBLE-SPLIT.md`), two classes of bugs emerged:

### Bug 1: Duplicate Thinking Bubbles

Two identical thinking bubble messages appeared in Telegram. The user saw two blockquotes with the same content back-to-back.

### Bug 2: Thinking Bubble Re-Editing After Split

The thinking bubble was still being edited at T+1min while the response was already streaming in a new bubble below it. The thinking bubble should be "sealed" (never touched again) once the split fires.

---

## Root Cause Analysis

### Bug 1: Duplicate Bubbles

`flushRender` (a timer-based periodic render) may have already **live-edited** message M1 with thinking content before `content_block_stop` fires. When the split ran, it called `_doSendOrEdit(thinkingHtml, null)` with `null` as the `targetMsgId`, which caused Telegram to **create a new message M2** instead of editing the existing M1.

Result: M1 (already containing thinking content) and M2 (freshly sent with the same content) both exist.

**Fix:** Capture `tgMessageId` into `capturedMsgId` before nulling it. Pass `capturedMsgId` to `_doSendOrEdit` so it edits M1 rather than creating M2.

### Bug 2: Re-Editing After Split

Three distinct race conditions allowed post-split edits to reach the sealed thinking bubble:

#### Race A — flushRender captures `tgMessageId` before seal is recorded

Timeline:
```
T0  flushRender fires → captures targetMsgId = X → chains _doSendOrEdit(html, X) onto sendQueue
T1  content_block_stop fires → capturedMsgId = X, tgMessageId = null (sync) → split chain queued
T2  split chain A: _doSendOrEdit(thinkingHtml, X) → edits X (correct, final edit)
T3  split chain B: sealedMsgIds.set(X, 'thinking') → seal recorded
T4  flushRender's chain item runs: _doSendOrEdit(html, X) — X is now sealed → [BLOCKQUOTE-REWRITE]
```

The seal was recorded **after** flushRender's item was already in the queue. By the time the check ran, it was too late.

**Fix:** Seal `capturedMsgId` **synchronously** in `onContentBlockStop` (before the chain starts) with state `'writing'`. This way, any flushRender item that runs later sees the seal before making the API call.

#### Race B — Pre-thinking bubble not sealed (thinkingIdx > 0)

In the mid-turn case (thinking appears after text/tool segments), the original message `capturedMsgId` is finalized with pre-thinking content by `_doSendOrEdit(preHtml, capturedMsgId)` but was never added to `sealedMsgIds`. Subsequent edits to it would go undetected.

**Fix:** After the pre-thinking edit completes, upgrade `capturedMsgId` from `'writing'` → `'bubble-end'`.

#### Race C — finalize() targeting a sealed message

`finalize()` captures `targetMsgId = this.tgMessageId` synchronously at call time. If the thinking split had already nulled `tgMessageId` before finalize runs, `targetMsgId = null` (correct). But if the seal state had changed by the time finalize's chain item runs, it could still target a now-sealed message.

**Fix:** In `finalize()`, check `sealedMsgIds` before using `targetMsgId`. If the ID is sealed, substitute `null` (create a fresh message) and log `[FINALIZE-SEALED-TARGET]`.

---

## Fixes Applied

### 1. Duplicate bubble fix (`streaming.ts` — `onContentBlockStop`)

```typescript
// Before (bug): always creates new message
this.sendQueue = this.sendQueue
  .then(() => this._doSendOrEdit(thinkingHtml || '…', null))  // null → new message M2

// After (fix): edits existing M1 if flushRender already sent it
const capturedMsgId = this.tgMessageId;
this.tgMessageId = null;
this.sendQueue = this.sendQueue
  .then(() => this._doSendOrEdit(thinkingHtml || '…', capturedMsgId))  // edits M1
```

### 2. Synchronous sealing (`onContentBlockStop`)

```typescript
// Seal synchronously before chain — fixes flushRender timing window
if (capturedMsgId) this.sealedMsgIds.set(capturedMsgId, 'writing');
// 'writing' = one authorized final edit pending; all other edits are violations
```

### 3. Local variable capture for thinking ID

```typescript
// Never read this.tgMessageId across a .then() boundary (flushRender can mutate it)
let capturedThinkingId: number | null = typeof capturedMsgId === 'number' ? capturedMsgId : null;
this.sendQueue = this.sendQueue
  .then(async () => {
    await this._doSendOrEdit(thinkingHtml || '…', capturedMsgId);
    // Capture immediately after await — same microtask, no macrotask gap possible
    if (capturedThinkingId === null) capturedThinkingId = this.tgMessageId;
  })
  .then(() => {
    if (capturedThinkingId) this.sealedMsgIds.set(capturedThinkingId, 'thinking');
    this.tgMessageId = null;
  })
```

### 4. Pre-thinking bubble sealed (thinkingIdx > 0)

```typescript
.then(async () => {
  // Upgrade: 'writing' → 'bubble-end' after pre-thinking content is finalized
  if (capturedMsgId) this.sealedMsgIds.set(capturedMsgId, 'bubble-end');
  await this._doSendOrEdit(thinkingHtml || '…', null);
  capturedThinkingId = this.tgMessageId;
})
```

### 5. finalize() sealed-ID guard

```typescript
const rawTargetId = this.tgMessageId;
if (rawTargetId !== null && this.sealedMsgIds.has(rawTargetId)) {
  this.logger?.warn?.({ targetMsgId: rawTargetId }, '[FINALIZE-SEALED-TARGET] ...');
}
const targetMsgId = (rawTargetId !== null && this.sealedMsgIds.has(rawTargetId))
  ? null : rawTargetId;
```

### 6. Sealed message ID tracking (`sealedMsgIds`)

Three-state map, never cleared (violations from past turns are still violations):

| State | Meaning |
|---|---|
| `'writing'` | Split has claimed this ID for one authorized final edit; any other edit is a violation |
| `'thinking'` | Thinking bubble fully sealed after split completes; any edit is a violation |
| `'bubble-end'` | Turn ended via `reset()`; any edit is a violation |

Detection logs emitted right before `sender.editMessage(...)` (lowest possible level):
- `[BLOCKQUOTE-REWRITE]` — editing a `'thinking'` sealed bubble
- `[OLD-BUBBLE-REWRITE]` — editing a `'bubble-end'` retired bubble
- `[FINALIZE-SEALED-TARGET]` — `finalize()` tried to target a sealed ID

### 7. SubAgentTracker edit guard

`SubAgentTracker.updateStandaloneMessage()` (which edits standalone sub-agent bubbles) now calls `onEditAttempt(msgId, preview)` right before its `sender.editMessage(...)`. Bridge.ts wires this to `accumulator.logIfSealed()` so violations from the sub-agent path are also detected.

---

## sealedMsgIds State Machine

```
           ┌──────────────────────────────────────────┐
           │         onContentBlockStop fires          │
           │  capturedMsgId is a known number          │
           ▼                                           │
     [ 'writing' ]  ←─────────────────────────────────┘
           │
           │  split's authorized edit completes
           │
    ┌──────┴──────────────────────┐
    │  thinkingIdx == 0           │  thinkingIdx > 0
    ▼                             ▼
[ 'thinking' ]            [ 'bubble-end' ]   (capturedMsgId, pre-thinking)
                                 │
                    new bubble sent → that ID
                                 ▼
                           [ 'thinking' ]   (new thinking bubble)

  reset() → current tgMessageId → [ 'bubble-end' ]
```

---

## Remaining Edge Cases

### 1. 429 Rate-Limit Retry During Split

`_doSendOrEdit` retries on 429 with `await sleep(N * 1000)`. During this sleep (a real async yield), flushRender timers fire. If `capturedMsgId` is in `'writing'` state and a flushRender retry tries to edit it, the check allows it (`'writing'` is not a violation). After the retry completes and the state upgrades to `'thinking'`, further edits are caught. No data loss, but two edit calls may reach Telegram for the same message.

### 2. splitMessage() with a sealed targetMsgId

`splitMessage()` captures `targetMsgId = this.tgMessageId` at call time (within `sendQueue`). If `tgMessageId` is null (correctly, after thinking split), `targetMsgId = null` and `splitMessage` creates a new message — correct. If for some reason `tgMessageId` holds a sealed ID at that point, `splitMessage` passes it to `_doSendOrEdit` where the check fires. No special guard added here — the existing check covers it.

### 3. Multiple Thinking Blocks in One Turn

CC can emit multiple sequential thinking blocks (rare). Each fires `content_block_stop` and attempts a split. The second thinking block's `capturedMsgId` would be `null` (the first split nulled `tgMessageId`), so it sends a fresh bubble. Both are sealed correctly. Not a problem in practice but not explicitly tested.

### 4. Thinking Block with No Prior TG Message (capturedMsgId = null)

If thinking is the very first content in a turn AND `firstSendReady` is false AND no timer has fired, `tgMessageId` is null at split time. The split sends a fresh thinking bubble (`_doSendOrEdit(thinkingHtml, null)`), captures the new ID via `capturedThinkingId = this.tgMessageId` (same microtask), seals it. Correct behavior, but the `capturedThinkingId = null` initial value means there's one microtask-level window between the send completing and the seal recording. Macrotasks cannot interrupt microtask continuations, so this is safe.

### 5. sealedMsgIds Memory Growth

`sealedMsgIds` never clears. Over a long session with many thinking turns, it accumulates one entry per thinking bubble and one per turn. At 1–2 entries per turn, memory growth is negligible (tens to hundreds of integers per session).

---

## Testing Checklist

- [ ] Single thinking block → one thinking bubble, one response bubble
- [ ] Thinking bubble is NOT re-edited after response starts streaming
- [ ] No duplicate thinking bubbles (Bug 1 regression)
- [ ] Mid-turn thinking (thinkingIdx > 0) → pre-thinking content stays in original bubble, thinking goes to new bubble
- [ ] No `[BLOCKQUOTE-REWRITE]` or `[OLD-BUBBLE-REWRITE]` log lines during normal operation
- [ ] `[FINALIZE-SEALED-TARGET]` does not fire during normal turns
- [ ] 429 rate-limit during split does not cause data loss or duplicate messages
- [ ] Multiple thinking blocks in one turn → each gets its own sealed bubble
