# TGCC OAuth Auth Fallback — Spec

## Problem

TGCC spawns CC non-interactively (`--input-format stream-json`). When the OAuth
token is expired or missing, CC returns a 401 and dies. The user has no
recovery path — TGCC just emits an error.

Interactive `claude` sessions handle this transparently (open browser). TGCC
cannot do that. This spec adds an equivalent recovery path via Telegram.

## Affected scenarios

1. **Token expired** — `expiresAt` has passed, refresh token also stale
2. **First run** — no `~/.claude/.credentials.json` exists yet
3. **Refresh token expired** — access token expired, refresh endpoint fails
4. **Anthropic endpoint down** — refresh works but returns 500/503

## Solution Overview

Three layers:

```
Layer 1: Proactive refresh   — check expiry on every CC spawn, refresh early
Layer 2: Reactive fallback   — on 401, open auth flow via Telegram
Layer 3: Retry               — after successful auth, retry original task
```

---

## Layer 1 — Proactive Token Refresh

**When:** Before spawning any CC process.

**Logic:**
1. Read `~/.claude/.credentials.json`
2. If `expiresAt` is within `proactiveRefreshMinutes` (default: 60 min), call
   the refresh endpoint:
   ```
   POST https://platform.claude.com/v1/oauth/token
   Content-Type: application/json
   {
     "grant_type": "refresh_token",
     "refresh_token": "<claudeAiOauth.refreshToken>",
     "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
   }
   ```
3. On success: write new `accessToken`, `refreshToken`, `expiresAt` back to
   credentials file.
4. On failure (non-200, network error): log warning, proceed to spawn anyway
   (Layer 2 will catch the resulting 401).

**No Telegram notification needed** — this is silent and automatic.

---

## Layer 2 — Reactive Auth Fallback (Telegram Flow)

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
Layer 2 kicks in.

---

## Layer 3 — Retry

After successful auth:
- Re-spawn the CC process with the same original message/task
- Mark it as a retry (don't trigger auth fallback again on this spawn)
- If retry also fails with auth error → send error, give up (avoid loops)

---

## Incoming Code Detection

TGCC needs to listen for the user's reply containing the auth code. Two options:

**Option A (simple):** Poll for new Telegram messages from `authFallbackChatId`
during the wait window. Any message that doesn't match a known command and
arrives during the wait window is treated as the auth code.

**Option B (explicit):** Require a prefix, e.g. `/authcode V2aoWGt...`

**Recommendation:** Option A — simpler UX, lower friction. Only one message
should be expected during the wait window.

---

## Config additions (config.ts)

```typescript
authFallbackEnabled: boolean          // default: true
authFallbackChatId: string            // default: telegramChatId
authFallbackTimeoutMs: number         // default: 300_000 (5 min)
proactiveRefreshEnabled: boolean      // default: true
proactiveRefreshMinutes: number       // default: 60
oauthClientId: string                 // default: "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
oauthTokenUrl: string                 // default: "https://platform.claude.com/v1/oauth/token"
credentialsPath: string               // default: "~/.claude/.credentials.json"
```

---

## Error messages (Telegram)

| Situation | Message |
|-----------|---------|
| Auth needed | 🔑 Claude needs re-authentication. Tap to sign in: `<URL>` — then reply with the code. |
| Timeout | ⚠️ Auth timed out (no code received in 5 min). Use `/auth` to retry manually. |
| Bad code | ❌ Auth failed (bad code?). Use `/auth` to try again. |
| Success | ✅ Authenticated. Retrying your task… |
| Proactive refresh ok | _(silent)_ |

---

## Files to modify / create

| File | Change |
|------|--------|
| `src/config.ts` | Add new config fields |
| `src/auth.ts` | **New** — proactive refresh + auth flow logic |
| `src/bridge.ts` | Call proactive refresh before spawn; catch 401, call auth fallback |
| `src/telegram.ts` | Add `waitForMessage(chatId, timeoutMs)` helper |

---

## Out of scope

- Multi-account support
- Rotating client IDs
- Non-Telegram notification channels
