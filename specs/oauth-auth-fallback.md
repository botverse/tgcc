# TGCC OAuth Auth Fallback — Spec

## Problem

TGCC spawns CC non-interactively (`--input-format stream-json`). When the OAuth
token is expired or missing, CC returns a 401 and dies. The user has no
recovery path — TGCC just emits an error.

Interactive `claude` sessions handle this transparently (open browser). TGCC
cannot do that. This spec adds an equivalent recovery path via Telegram.

## Design Decision: Layer 2 Only (Conservative)

We deliberately avoid Layer 1 (proactive token refresh) to stay conservative
after Anthropic's OpenClaw policy changes (April 2026). TGCC should not
directly manipulate CC's OAuth tokens — that crosses the boundary between
"using CC programmatically" and "acting as an OAuth client."

Instead, we only implement **reactive detection + notification**: detect the
401, run CC's own `claude auth login` command, and let the user complete the
flow themselves via Telegram. This keeps TGCC firmly in the "CC frontend" role.

## Affected scenarios

1. **Token expired** — `expiresAt` has passed, refresh token also stale
2. **First run** — no `~/.claude/.credentials.json` exists yet
3. **Refresh token expired** — access token expired, refresh endpoint fails
4. **Anthropic endpoint down** — refresh works but returns 500/503

## Solution: Reactive Auth Fallback (Telegram Flow)

**Trigger:** CC process result contains auth error:
- `"OAuth token has expired"`
- `"Authentication failed"`
- `"Invalid authorization code"`
- HTTP 401 in CC stderr/result

**Flow:**

```
TGCC detects 401
    │
    ▼
Spawn `claude auth login` subprocess (capture stdout)
    │
    ▼
Extract OAuth URL from stdout via regex
(https://claude.ai/oauth/authorize?...)
    │
    ▼
Send Telegram message to authFallbackChatId:
  "🔑 Claude auth needed. Tap to sign in: <URL>
   After signing in, send me the authorization code."
    │
    ▼
Wait for incoming Telegram message from authFallbackChatId
containing the code (timeout: authFallbackTimeoutMs, default: 5 min)
    │
    ├─ timeout → send error message, abort
    │
    ▼
Write code to `claude auth login` stdin
    │
    ▼
Wait for process to exit (success/failure)
    │
    ├─ failure → send error message, abort
    │
    ▼
Send Telegram confirmation: "✅ Auth successful. Retrying your task..."
    │
    ▼
Retry original CC spawn (once)
```

**First run:** Same flow. No credentials file → CC fails with auth error →
fallback kicks in.

---

## Retry Logic

After successful auth:
- Re-spawn the CC process with the same original message/task
- Mark it as a retry (don't trigger auth fallback again on this spawn)
- If retry also fails with auth error → send error, give up (avoid loops)

---

## Incoming Code Detection

TGCC needs to listen for the user's reply containing the auth code. Two options:

**Option A (simple):** Any message from `authFallbackChatId` during the wait
window that doesn't match a known command is treated as the auth code.

**Option B (explicit):** Require a prefix, e.g. `/authcode V2aoWGt...`

**Recommendation:** Option A — simpler UX, lower friction.

---

## Config additions (config.ts)

```typescript
authFallbackEnabled: boolean          // default: true
authFallbackChatId: string            // default: telegramChatId
authFallbackTimeoutMs: number         // default: 300_000 (5 min)
```

---

## Error messages (Telegram)

| Situation | Message |
|-----------|---------|
| Auth needed | 🔑 Claude needs re-authentication. Tap to sign in: `<URL>` — then reply with the code. |
| Timeout | ⚠️ Auth timed out (no code received in 5 min). Use `/auth` to retry manually. |
| Bad code | ❌ Auth failed (bad code?). Use `/auth` to try again. |
| Success | ✅ Authenticated. Retrying your task… |

---

## Files to modify / create

| File | Change |
|------|--------|
| `src/config.ts` | Add new config fields |
| `src/auth.ts` | **New** — auth error detection + `claude auth login` flow |
| `src/bridge.ts` | Catch 401 on CC spawn/result, call auth fallback |
| `src/telegram.ts` | Add `waitForMessage(chatId, timeoutMs)` helper |

---

## Out of scope

- Proactive token refresh (Layer 1) — deliberately excluded
- Multi-account support
- Rotating client IDs
- Non-Telegram notification channels
