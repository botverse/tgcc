# OpenClaw CC Spawn — Protocol Fix Spec

## Problem

OpenClaw's `runner.ts` sends the initial `user` message to CC's stdin immediately after spawn, **without first sending a `control_request` with `subtype: "initialize"`**. 

On CC v2.1.50+, this causes CC to silently ignore the user message. CC waits for the SDK initialize handshake before processing user messages.

The protocol types (`CCControlRequest`, `CCControlRequestPayload` with `subtype: "initialize"`) are already defined in `protocol.ts` but never used.

### Symptoms
- CC spawns, user message is sent, but CC never responds
- No error output — CC just sits there
- Eventually killed by idle/timeout timer
- `result` event never arrives

### Root Cause (verified by testing)
CC v2.1.50 stream-json mode requires:
1. Client sends `{type: "control_request", request_id: "<uuid>", request: {subtype: "initialize"}}` on stdin
2. CC responds with `{type: "control_response", ...}` on stdout
3. CC is now ready to accept `{type: "user", ...}` messages

Without step 1, CC reads stdin but never processes user messages.

### Additional Finding (from TGCC)
After sending `control_request`, CC responds with `control_response` but does **not** emit `system.init` until the first user message is sent. So:
- Send initialize → get `control_response` → send user message → get `system.init` + assistant response

## Changes Required

### `src/agents/claude-code/runner.ts`

**In `executeSpawn()`, between step 6 (spawn) and step 7 (send task):**

```typescript
// 6b. Send SDK initialize handshake
const initRequest = JSON.stringify({
  type: "control_request",
  request_id: crypto.randomUUID(),
  request: { subtype: "initialize" },
});
child.stdin.write(initRequest + "\n");
ndjsonLog.logStdin(initRequest);
log.info(`control_request initialize sent, pid=${child.pid}`);
```

This goes RIGHT BEFORE the existing user message write at line ~316.

**In the NDJSON parse loop, update the `control_response` handler:**

Current (line ~614):
```typescript
case "control_response": {
  log.info(`control response: ${msg.response.subtype} for ${msg.response.request_id}`);
  break;
}
```

This is already fine — we just log it. No state transition needed because we send the user message immediately after the initialize request (unlike TGCC which had a queue/state machine). CC will process the control_request, emit control_response, then process the user message — all in order on the same stdin stream.

### `src/agents/claude-code/protocol.ts`

Already correct — `CCControlRequest` with `subtype: "initialize"` is already defined. No changes needed.

### Follow-up messages (`sendFollowUp`, `sendFollowUpAndWait`)

These are fine — they send to an already-initialized CC process. No changes needed.

## Testing

1. `pnpm build` must pass
2. `pnpm test` — update any tests that mock the CC spawn flow
3. Manual test: `sessions_spawn(mode: "claude-code")` should now get responses from CC

## Risk Assessment

**Low risk:** This is additive — we're sending one extra line to stdin before the existing user message. The control_request is already typed in protocol.ts. CC processes stdin messages in order, so the initialize request will be handled before the user message arrives.
