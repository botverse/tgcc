# TGCC Specs

## 1. CLI Command (`tgcc`)

**Goal:** Send messages to a running TGCC agent from the command line, via Unix socket.

### Architecture
- TGCC service exposes a **Unix socket** per agent at `/tmp/tgcc/ctl/{agentId}.sock`
- CLI binary at `~/.local/bin/tgcc` connects to the socket and sends commands
- Same message path as Telegram: if an active CC process exists, message goes to it; otherwise starts a new session with `--continue`

### CLI Interface
```
tgcc message "fix the tests"                    # auto-detect agent from cwd repo (must match an agent's default repo)
tgcc message --agent test "fix the tests"       # explicit agent
tgcc message --session <id> "fix the tests"     # resume specific session
tgcc status                                     # show running agents and active sessions
tgcc status --agent test                        # show specific agent status
```

### Agent Resolution from cwd
- Match `cwd` against all agents' `defaults.repo` paths
- Each repo is exclusive to one agent — no two agents share a default repo
- If `cwd` is inside an agent's repo → use that agent
- If `cwd` doesn't match any agent's repo → error: "No agent configured for this repo"

### Control Socket Protocol (NDJSON over Unix socket)
```jsonc
// Request
{"type": "message", "text": "fix the tests", "agent": "test", "session": "uuid"}
{"type": "status", "agent": "test"}

// Response  
{"type": "ack", "sessionId": "uuid", "state": "active|spawning"}
{"type": "status", "agents": [...], "sessions": [...]}
{"type": "error", "message": "..."}
```

### Implementation
- **New files:** `src/ctl-server.ts` (Unix socket server), `src/cli.ts` (CLI entry point)
- **Bridge integration:** `bridge.ts` gets a `handleCliMessage()` method using the same `handleUserMessage()` path that Telegram uses
- **Package.json:** Add `"bin": { "tgcc": "dist/cli.js" }` and a postinstall symlink to `~/.local/bin/tgcc`

---

## 2. Agent Registration CLI

**Goal:** Register and manage agents from CLI.

### CLI Interface
```
tgcc agent add <name> --bot-token <token> --repo <path>    # with default repo
tgcc agent add <name> --bot-token <token>                   # generic agent (no default repo)
tgcc agent remove <name>
tgcc agent list
tgcc agent repo <name> <path>                               # set/change default repo
```

### Generic Agents (no default repo)
- When a generic agent receives a message with no active `/repo` override, it prompts the user to select a repo from a list
- List comes from: all registered agent default repos + any repos defined in a top-level `repos` config array
- Once selected, the repo persists for the session

### `/repo` Override Behavior
- **Agent with default repo:** `/repo <other-path>` switches temporarily. Reverts to default repo after session idle timeout.
- **Generic agent:** `/repo <path>` sets the active repo. Persists until changed or session ends.

### Writes to Config
- Edits `~/.tgcc/config.json` directly
- Hot-reload picks up the change automatically (config watcher, 1s poll)
- Service creates/destroys Telegram bot instances for new/removed agents

---

## 3. `/sessions` with Inline Buttons

**Goal:** Make sessions clickable for resume, show titles and stats.

### Current
```
`a1b2c3d4` — 5 msgs, $0.0190 (2 min ago)
```

### Proposed
```
📋 Recent sessions:

1. "Fix auth middleware" — 5 msgs, $0.02 (2 min ago)
   [Resume] [Delete]

2. "Update tests" — 3 msgs, $0.01 (1h ago)
   [Resume]
```

### Implementation
- **Session title:** Capture first user message (truncated to 40 chars) as session title in `SessionStore`
- **Inline buttons:** Use grammY's `InlineKeyboard` with callback data like `resume:{sessionId}` and `delete:{sessionId}`
- **Callback handler:** Add `bot.on("callback_query:data")` handler in `telegram.ts` that parses the action and delegates to bridge

---

## 4. Session Lifecycle Management

### Current State (problems)
- **Hang timer** (5 min): kills CC if no stdout for 5 minutes. Too aggressive — CC doing long tool calls (builds, web fetches) can be silent for minutes.
- **Idle timer** (5 min): kills CC if no new user message in 5 minutes after a turn completes. This is reasonable.
- **On exit:** process goes to `idle`, next message spawns with `--continue`. This is correct.
- **On hang → "restarting":** Kills hung process and immediately restarts. Wrong — should take over naturally.
- **No session takeover detection:** If user opens the same session in VS Code or CLI, TGCC doesn't know.

### CC Extension Architecture (from deobfuscated source at ~/Botverse/cc-deobfuscated/)

Key findings from the CC CLI v2.1.50 source:

1. **Session persistence** uses a remote API with PUT and UUID-based last-write-wins conflict resolution. 409 responses indicate concurrent modification — CC adopts the server's `lastUuid` and retries.

2. **The stream-json SDK protocol** supports:
   - `control_request` / `control_response` for initialization and permission grants
   - `control_cancel_request` for aborting pending requests
   - `user`, `assistant`, `system` message types for the conversation

3. **SessionsWebSocket** class (`pQ8`) manages remote session connections with ping/reconnect. It sends/receives control requests and user messages over WebSocket.

4. **RemoteSessionManager** (`QQ8`) wraps the WebSocket with higher-level session lifecycle: connected/disconnected events, permission request handling, and message routing.

5. **No local lock file mechanism found.** Session conflict is handled at the API level (409 responses), not via local filesystem locks. This means we can't check for local locks to detect VS Code takeover.

6. **Session exit signals:** CC listens for SIGINT, SIGTERM, SIGHUP and handles graceful shutdown.

### Proposed Changes

#### 4a. Smart Hang Detection

Track CC's state from stream-json events to avoid false kills:

1. **CC State Machine (derived from stream events):**
   - `idle` → no active turn
   - `thinking` → between `message_start` and first content/tool_use
   - `responding` → producing text content blocks
   - `tool_executing` → CC emitted `stop_reason: "tool_use"`, waiting for tool result  
   - `waiting_for_api` → sent request, waiting for API response (long silence expected)

2. **Hang detection logic:**
   ```
   CC silent for N seconds →
     if tool_executing → check hasActiveChildren(cc.pid)
       if yes → extend timeout by 5 min (subprocess is working)
       if no → wait another 60s, then declare hung
     if waiting_for_api → extend timeout (API can be slow)
     if thinking/responding → likely truly hung after 5 min
     if idle → shouldn't have hang timer running
   ```

3. **hasActiveChildren check:**
   ```typescript
   function hasActiveChildren(pid: number): boolean {
     try {
       execSync(`pgrep --parent ${pid}`, { stdio: 'ignore' });
       return true;
     } catch { return false; }
   }
   ```

Reference: OpenClaw's `runner.ts` uses similar state tracking at lines 93-110, 400-480.

#### 4b. Natural Takeover (not restart)

When CC is hung or idle timeout fires:

1. **Kill the process** (SIGTERM, wait 5s, SIGKILL if needed)
2. **Keep the session ID** — don't discard it
3. **Notify user:** "CC session paused. Send a message to continue."
4. **On next message:** spawn CC with `--resume <sessionId>` — seamless continuation
5. **The user roaming between devices (laptop ↔ phone) should feel transparent** — TGCC is just another client that `--resume`s the session when needed

Remove "CC process hung — restarting..." messaging. There is no restart. The session lives; the process is ephemeral.

#### 4c. Session Takeover Detection

**Problem:** User opens the session in VS Code or CC CLI while TGCC's CC process is active.

**Detection signals (from CC source analysis):**

1. **CC exits unexpectedly** — VS Code or CLI taking over may cause the existing CC process to fail or get killed
2. **Remote API 409 conflicts** — CC logs "session_persist_fail_concurrent_modification" when another client modifies the same session
3. **CC stdout goes silent + process exits** — the other client wins

**Proposed approach:**

1. **On CC unexpected exit (non-zero code, signal):**
   - Check if exit was due to SIGTERM from us (expected) vs external signal (takeover)
   - If external: mark session as "externally owned", stop managing it
   - Notify user: "Session was picked up by another client."

2. **On next Telegram message after takeover:**
   - Don't try to `--resume` the same session (the other client owns it)
   - Start a fresh session OR ask user which session to use

3. **Graceful yield:** When TGCC detects competition, it should yield rather than fight. The VS Code/CLI user experience is richer, so TGCC should defer.

4. **Future: WebSocket integration** — CC's `SessionsWebSocket` class could theoretically be used by TGCC to participate in the session lifecycle properly, but this is a v2 feature.

---

## 5. Repo Registry

**Goal:** Central repo registry that agents reference.

### Config Structure
```json
{
  "repos": {
    "tgcc": "/home/fonz/Botverse/tgcc",
    "kyo": "/home/fonz/Botverse/KYO",
    "sentinella": "/home/fonz/Botverse/sentinella",
    "openclaw": "/home/fonz/Projects/openclaw"
  },
  "agents": {
    "test": {
      "botToken": "...",
      "allowedUsers": ["7016073156"],
      "defaults": {
        "repo": "tgcc",
        "model": "claude-opus-4-6"
      }
    },
    "dev": {
      "botToken": "...",
      "allowedUsers": ["7016073156"],
      "defaults": {
        "model": "claude-opus-4-6"
      }
    }
  }
}
```

- Agent `defaults.repo` references a key from `repos` (exclusive — one agent per repo)
- Generic agents (no `defaults.repo`) can `/repo <name>` to pick from the registry
- CLI resolves cwd against the `repos` map for agent auto-detection

---

## Priority Order

1. **4a. Smart hang detection** — highest impact, prevents false kills
2. **4b. Natural takeover** — improves UX, removes misleading "restarting"
3. **3. /sessions buttons** — quick UX win
4. **1. CLI command** — enables BossBot/external integration
5. **5. Repo registry** — foundation for multi-repo management
6. **2. Agent registration** — convenience CLI
7. **4c. Session takeover** — needs more CC behavior testing

## Reference Material

- **Deobfuscated CC source:** `~/Botverse/cc-deobfuscated/cli-beautified.js` (502K lines, js-beautify formatted)
- **OpenClaw CC runner:** `~/Projects/openclaw/src/agents/claude-code/runner.ts` (state tracking, hang detection)
- **TGCC source:** `~/Botverse/tgcc/src/` (current implementation)
