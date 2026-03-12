# TGCC Streaming & Rendering Reference

How stream events become Telegram messages: what goes in which bubble, which gets a blockquote, and every timer involved.

---

## 1. Segment Types & Their Rendering

Every piece of content is stored as a **segment** in `this.segments[]`. `renderHtml()` maps them to HTML strings and joins with `\n`.

| Segment type | What creates it | HTML output | Blockquote? |
|---|---|---|---|
| `thinking` | `content_block_start` type=`thinking` | `<blockquote expandable>💭 …</blockquote>` | ✅ expandable |
| `text` | `content_block_start` type=`text` | raw markdown→HTML (no wrapper) | ❌ |
| `tool` pending | `content_block_start` type=`tool_use` (non-agent) | `<blockquote>⚡ …</blockquote>` | ✅ |
| `tool` resolved | `resolveToolMessage()` | `<blockquote>⚡ 1.2s · ✔ cmd\n<code>stat</code></blockquote>` | ✅ |
| `tool` error | `resolveToolMessage()` | `<blockquote>⚡ 1.2s · ✘ cmd</blockquote>` | ✅ |
| `subagent` running | `content_block_start` (Agent/SendMessage/…) | `<blockquote>🤖 label — Working (1s)…</blockquote>` | ✅ |
| `subagent` completed | `resolveToolMessage()` | `<blockquote>🤖 label — ✔ Done (3s)</blockquote>` | ✅ |
| `supervisor` | `addSupervisorMessage()` | `<blockquote>🦞 text</blockquote>` or expandable if >200 chars | ✅ |
| `usage` | `finalize()` | `<blockquote>📊 …tokens…cost…</blockquote>` | ✅ |
| `image` | `sendImage()` | `` (no content — image sent separately via API) | ❌ |

### thinking: special `<pre>` handling

Telegram cannot nest `<pre>` inside `<blockquote expandable>`. Thinking segments convert all code blocks to inline `<code>` before wrapping:

```
markdown code fence → <code>inline collapsed</code>
NOT → <pre><code>...</code></pre>
```

Text segments do NOT have this problem because they have no blockquote wrapper.

---

## 2. The Segment Pipeline

```
CC stream event
      │
      ▼
 handleEvent()
      │
      ├─ content_block_start  → onContentBlockStart()  → push segment to this.segments[]
      │                                                  → requestRender()
      │
      ├─ content_block_delta  → onContentBlockDelta()   → update seg.rawText + seg.content
      │                                                  → requestRender()
      │
      ├─ content_block_stop   → onContentBlockStop()    → finalize segment
      │                          (async, not awaited)   → for thinking: run SPLIT LOGIC
      │
      ├─ tool_result          → resolveToolMessage()    → update tool seg status/elapsed
      │                                                  → requestRender()
      │
      ├─ message_start        → (bridge calls softReset or reset)
      │
      └─ result               → (bridge calls finalize())
```

---

## 3. renderHtml() — What Gets Rendered

`renderHtml()` at line 670 maps `this.segments[]` and filters:

```
this.segments
    │
    ├─ thinking + splitOff=true    → '' (already in own bubble)
    ├─ thinking + pendingSplit=true → '' (will be split, don't flash in response bubble)
    ├─ tool + pending + hideTimer   → '' (fast tool, suppress 500ms)
    └─ everything else              → seg.content (pre-computed HTML)

    .filter(c => c.length > 0)
    .join('\n')
    || '…'
```

The result is a single HTML string representing the **current** message bubble.

---

## 4. The Send Queue

**All Telegram API calls go through `this.sendQueue`** — a promise chain that serialises every edit/send:

```
this.sendQueue = this.sendQueue
    .then(() => this._doSendOrEdit(...))
    .then(() => this._doSendOrEdit(...))   ← chained, never parallel
    .catch(err => log)
```

`_doSendOrEdit(html, targetMsgId?)`:
- `targetMsgId = null/undefined + no tgMessageId` → **sendMessage** (new bubble), sets `this.tgMessageId`
- `targetMsgId = number` or `this.tgMessageId` exists → **editMessage** (update existing bubble)
- `text === '…' && msgId` → **skip** (avoid edit-loop with placeholder)
- 429 error → **exponential backoff** + retry (see §7)

---

## 5. Bubble Lifecycle: Normal Turn

```
Turn starts
    │
    ├─ bridge calls reset() or softReset()
    │       reset():     tgMessageId=null, segments=[], seal old ID as 'bubble-end'
    │       softReset(): tgMessageId KEPT,  segments KEPT (tool-use loop reuse)
    │
    ▼
text block starts → text segment pushed, deltas arrive → requestRender()
    │
    ▼
[firstSendReady gate]
    ├─ 200+ chars of text OR 2s elapsed → send first TG message (new bubble)
    └─ neither → wait (firstSendTimer fires after remaining time)
    │
    ▼
tool_use block starts → tool segment pushed
    │   ├─ toolHideTimer: 500ms before ⚡ pending shows
    │   └─ requestRender() after 500ms if not resolved yet
    │
    ▼
tool_result arrives → resolve tool seg (✔/✘), elapsed computed → requestRender()
    │
    ▼
more text/tools accumulate in SAME tgMessageId (softReset keeps it)
    │
    ▼
result event → finalize()
    │   ├─ append usage segment (📊)
    │   ├─ sealed = true (no more renders)
    │   └─ _doSendOrEdit(final html, targetMsgId)
    │
    ▼
Single TG message updated throughout turn
```

---

## 6. Bubble Lifecycle: Thinking Block

### 6a. Thinking is FIRST segment (thinkingIdx == 0)

```
Turn starts → reset() → tgMessageId = null
    │
    ▼
content_block_start type=thinking
    pendingSplit = (segments.length > 0) = FALSE
    → push thinking seg
    → requestRender()
    │
    ▼
thinking deltas arrive → seg.rawText grows → requestRender()
    │
    ▼
[firstSendReady gate may fire] → sends TG message with thinking content
    → tgMessageId = MSG_A
    │
    ▼
content_block_stop (thinking)
    ├─ cancel flushTimer
    ├─ capturedMsgId = MSG_A (or null if not sent yet)
    ├─ seg.splitOff = true  (synchronous)
    ├─ segments = []        (synchronous)
    ├─ tgMessageId = null   (synchronous)
    ├─ sealedMsgIds[MSG_A] = 'writing'  (synchronous)
    │
    └─ sendQueue chain:
           .then() → _doSendOrEdit(thinkingHtml, MSG_A)   ← EDIT existing (or send new)
                    → capturedThinkingId = tgMessageId
           .then() → sealedMsgIds[capturedThinkingId] = 'thinking'
                    → tgMessageId = null
    │
    ▼
text block starts → new text segment → tgMessageId still null
    → next send creates MSG_B (response bubble)

RESULT:
  MSG_A = 💭 thinking bubble (sealed)
  MSG_B = response text bubble
```

### 6b. Thinking is MID-TURN (thinkingIdx > 0) — text/tools came first

```
Turn in progress → tgMessageId = MSG_A (response bubble exists)
    segments = [text, tool, tool, ...]
    │
    ▼
content_block_start type=thinking
    pendingSplit = (segments.length > 0) = TRUE  ← KEY FIX
    → push thinking seg
    → requestRender()
      renderHtml() SKIPS thinking (pendingSplit=true)
      → MSG_A NOT updated with thinking content  ✓ no flash
    │
    ▼
thinking deltas arrive → seg.rawText grows → requestRender()
    renderHtml() still skips (pendingSplit still true)
    │
    ▼
content_block_stop (thinking)
    ├─ thinkingIdx > 0 path
    ├─ preHtml = segments[0..thinkingIdx-1] content joined (text + tools)
    ├─ capturedMsgId = MSG_A
    ├─ thinkingHtml = seg.content  (thinking HTML, computed despite being hidden)
    ├─ seg.splitOff = true         (synchronous)
    ├─ segments = segments[thinkingIdx+1..]  (synchronous, removes thinking + pre)
    ├─ tgMessageId = null          (synchronous)
    ├─ sealedMsgIds[MSG_A] = 'writing'  (synchronous)
    │
    └─ sendQueue chain:
           .then() → _doSendOrEdit(preHtml, MSG_A)     ← edit MSG_A back to pre-thinking only
                                                           (likely "not modified" — never had thinking)
           .then() → sealedMsgIds[MSG_A] = 'bubble-end'
                    → _doSendOrEdit(thinkingHtml, null) ← new MSG_B (thinking bubble)
                    → capturedThinkingId = tgMessageId (= MSG_B)
           .then() → sealedMsgIds[MSG_B] = 'thinking'
                    → tgMessageId = null
    │
    ▼
text block starts → new text segment → tgMessageId null
    → next send creates MSG_C (new response bubble)

RESULT:
  MSG_A = pre-thinking text/tools bubble (sealed as 'bubble-end')
  MSG_B = 💭 thinking bubble (sealed as 'thinking')
  MSG_C = post-thinking response bubble
```

---

## 7. All Timers

### 7a. flushTimer — render throttle

```
requestRender() called
    │
    elapsed = now - lastEditTime
    delay   = max(0, editIntervalMs - elapsed)
    │
    ├─ delay = 0   → flushRender fires immediately (next microtask)
    └─ delay = N   → setTimeout(flushRender, N)

    editIntervalMs default: 1000ms
    editIntervalMs max:     5000ms (after 429 backoff)
```

**Cleared by:** `clearFlushTimer()` — called in `softReset()`, `reset()`, `finalize()`, and in `onContentBlockStop()` before thinking split takes over sequencing.

### 7b. firstSendTimer — first-message gate

```
New turn starts (reset() called)
    firstSendReady = false
    │
    flushRender() called, no tgMessageId yet
    checkFirstSendReady():
        ├─ text chars >= 200  → firstSendReady=true, send now ✓
        ├─ elapsed >= 2000ms  → firstSendReady=true, send now ✓
        └─ neither → start firstSendTimer if not running
    │
    firstSendTimer = setTimeout(() => {
        firstSendReady = true
        requestRender()          ← triggers flush on next tick
    }, max(0, 2000 - elapsed))
```

**Cleared by:** text threshold hit early, `finalize()` (force-sets `firstSendReady=true`), `softReset()`, `reset()`.

**Purpose:** Avoid sending a TG message with just "…" for fast turns. Waits for meaningful content.

### 7c. toolHideTimers — fast-tool suppressor

```
content_block_start (tool_use)
    │
    toolHideTimers.set(blockId, setTimeout(() => {
        toolHideTimers.delete(blockId)
        requestRender()          ← now shows ⚡ pending
    }, 500ms))
    │
    ├─ tool resolves < 500ms → clearTimeout(hideTimer), render ✔ directly (no pending flash)
    └─ tool takes > 500ms   → timer fires, ⚡ pending appears, then updates to ✔ on resolve

renderHtml(): tool seg hidden while hideTimer is running
```

**Cleared by:** tool resolution, `softReset()`, `reset()`.

### 7d. 429 backoff sleep (inline in _doSendOrEdit)

```
Telegram editMessage → 429 Too Many Requests
    │
    retryAfter = response.parameters.retry_after ?? 5
    editIntervalMs = min(editIntervalMs * 2, 5000)   ← exponential backoff, cap 5s
    await sleep(retryAfter * 1000)
    return _doSendOrEdit(text, targetMsgId)           ← recursive retry
```

Not a timer per se — inline `await sleep()` inside the sendQueue chain.

---

## 8. splitThreshold — Message Splitting

Default: **4000 chars** of rendered HTML.

```
flushRender() or finalize():
    html = renderHtml()
    │
    ├─ html.length > 4000 → splitMessage()
    └─ html.length ≤ 4000 → _doSendOrEdit(html, targetMsgId)


splitMessage():
    totalLen = 0
    walk segments[], accumulate content lengths
    find first segment where totalLen > 4000 → splitSegIdx
    (if splitSegIdx == 0 → bump to 1, always send at least one segment)
    │
    firstSegs = segments[0..splitSegIdx)
    firstHtml = firstSegs.map(s => s.content).join('\n')
    this.segments = segments[splitSegIdx..]    ← set BEFORE await (stream events safe)
    │
    await _doSendOrEdit(firstHtml, capturedMsgId)   ← edit/send first part
    this.tgMessageId = null
    restHtml = renderHtml()                          ← renders remaining segments
    await _doSendOrEdit(restHtml)                    ← new bubble for rest
```

Telegram hard limit is 4096 chars. Safety buffer: ~96 chars for tags overhead.

---

## 9. Sealed Message IDs

Never-cleared map from `msgId → state`. Prevents editing retired bubbles.

```
State machine per msgId:

  (unseen)
      │
      │ thinking split claims msgId for final edit
      ▼
  'writing'  ─── authorized edit in progress
      │
      │ edit complete
      ▼
  'thinking' ─── thinking bubble done; any edit = violation [BLOCKQUOTE-REWRITE]

OR:

  (unseen)
      │
      │ reset() retires current bubble
      ▼
  'bubble-end' ── turn ended; any edit = violation [OLD-BUBBLE-REWRITE]


Read at three points:
  1. logIfSealed()       — SubAgentTracker calls before editing its standalone msg
  2. finalize()          — skips sealed targetMsgId, creates new bubble instead
  3. _doSendOrEdit()     — lowest-level log right before editMessage API call
```

### finalize() sealed-ID check (streaming.ts:884-890)

When `finalize()` runs, the thinking split may have already sealed the current `tgMessageId` (e.g., as `'thinking'` or `'bubble-end'`). If `finalize()` naively captured `this.tgMessageId` and passed it to `_doSendOrEdit()`, it would attempt to edit a retired bubble. To prevent this:

1. `finalize()` captures `rawTargetId = this.tgMessageId` before any reset can clear it.
2. It checks `this.sealedMsgIds.has(rawTargetId)`.
3. If sealed, it logs `[FINALIZE-SEALED-TARGET]` and forces `targetMsgId = null`, which causes `_doSendOrEdit()` to create a **new** message instead of editing the sealed one.

This guard is essential for the mid-turn thinking split (section 6b), where `tgMessageId` is nulled asynchronously inside the sendQueue but `finalize()` may still hold a stale reference.

---

## 10. reset() vs softReset()

```
                     softReset()         reset()
─────────────────────────────────────────────────────
tgMessageId          KEPT                null (+ sealed as 'bubble-end')
segments[]           KEPT                []
currentSegment       null                null
currentBlockType     null                null
sealed               false               false
turnUsage            null                null
flushTimer           cleared             cleared
toolHideTimers       cleared             cleared
firstSendReady       KEPT                false
firstSendTimer       KEPT                cleared
lastEditTime         KEPT                0
messageIds           KEPT                []
sendQueue            KEPT                KEPT (prev queue preserved)
turnStartTime        KEPT                Date.now()
```

**When called:**
- `softReset()` → `message_start` within a tool-use loop (same turn, reuse bubble)
- `reset()` → `message_start` when previous turn was sealed (new turn, new bubble)

---

## 11. Full Flow Example: Text → Tool → Think → Text

```
──────────────────────────────────────────────────────────────────
EVENT                    SEGMENTS[]              tgMessageId
──────────────────────────────────────────────────────────────────
reset()                  []                      null
─────────────────────────────────────────────────────────────────
cbs: text                [text:""]               null
cbd: text "Here's…"     [text:"Here's…"]         null  → requestRender
   [firstSendReady: 200 chars hit]
   → flushRender → _doSendOrEdit → SEND → MSG_A
                                                 MSG_A
─────────────────────────────────────────────────────────────────
cbs: tool_use            [text,tool:pending]     MSG_A
   toolHideTimer(500ms) starts
cbd: input               [text,tool:pending]     MSG_A → requestRender
   → flushRender → _doSendOrEdit(html,MSG_A)     MSG_A (edited, tool hidden)
   [500ms passes]
   → toolHideTimer fires → requestRender
   → flushRender → _doSendOrEdit → EDIT MSG_A    MSG_A (⚡ pending visible)
─────────────────────────────────────────────────────────────────
cbs: stop (tool)         [text,tool:dispatched]  MSG_A
─────────────────────────────────────────────────────────────────
softReset()  ← bridge on message_start (tool loop)
─────────────────────────────────────────────────────────────────
tool_result arrives      [text,tool:resolved]    MSG_A → requestRender
   → flushRender → EDIT MSG_A (⚡ ✔)             MSG_A
─────────────────────────────────────────────────────────────────
cbs: thinking            [text,tool,think]       MSG_A
   pendingSplit = true (segments.length > 0)
   → requestRender → renderHtml skips think → no change to MSG_A ✓
─────────────────────────────────────────────────────────────────
cbd: thinking deltas     [text,tool,think↑]      MSG_A (unchanged, pendingSplit hides it)
─────────────────────────────────────────────────────────────────
cbs: stop (thinking)     thinkingIdx=2 > 0
   preHtml = text+tool content
   capturedMsgId = MSG_A
   seg.splitOff = true (sync)
   segments = []  (sync, removes all 3)
   tgMessageId = null (sync)
   sealedMsgIds[MSG_A] = 'writing' (sync)
   sendQueue:
     → EDIT MSG_A with preHtml  (likely "not modified")
     → sealedMsgIds[MSG_A] = 'bubble-end'
     → SEND thinkingHtml → MSG_B
     → sealedMsgIds[MSG_B] = 'thinking'
     → tgMessageId = null
                                 null
─────────────────────────────────────────────────────────────────
softReset() ← bridge on message_start (new assistant turn)
─────────────────────────────────────────────────────────────────
cbs: text                [text:""]               null
cbd: text "Result…"     [text:"Result…"]         null → requestRender
   → flushRender → SEND → MSG_C                  MSG_C
─────────────────────────────────────────────────────────────────
result → finalize()
   append usage seg      [text,usage]             MSG_C
   → EDIT MSG_C (text + 📊 footer)               MSG_C
──────────────────────────────────────────────────────────────────

FINAL BUBBLES:
  MSG_A  pre-thinking text + tool result  ('bubble-end')
  MSG_B  💭 thinking                      ('thinking')
  MSG_C  response text + 📊 usage
```

---

## 12. editIntervalMs Rate Limiting

```
requestRender()
    │
    elapsed = now - lastEditTime
    │
    ├─ elapsed >= editIntervalMs (1000ms default) → delay=0, fire immediately
    └─ elapsed <  editIntervalMs                  → delay=(editIntervalMs-elapsed), wait

    Every _doSendOrEdit() sets lastEditTime = now

    429 received → editIntervalMs = min(editIntervalMs*2, 5000)
                                    1000 → 2000 → 4000 → 5000 (capped)

    reset() sets lastEditTime = 0 → next turn starts fresh, no artificial delay
```

This means at normal speed: at most **1 Telegram edit per second** per accumulator.
