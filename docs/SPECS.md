# TGCC Specs

## 1. CLI Command (`tgcc`)

**Goal:** Send messages to a running TGCC agent from the command line, via Unix socket.

### Architecture
- TGCC service exposes a **Unix socket** per agent at `/tmp/tgcc/ctl/{agentId}.sock`
- CLI binary at `~/.local/bin/tgcc` connects to the socket and sends commands
- Same message path as Telegram: if an active CC process exists, message goes to it; otherwise starts a new session with `--continue`

### CLI Interface
```
tgcc message "fix the tests"                    # auto-detect agent from cwd repo
tgcc message --agent test "fix the tests"       # explicit agent
tgcc message --repo ~/project "fix the tests"   # explicit repo (for /repo override)
tgcc message --session <id> "fix the tests"     # resume specific session
tgcc status                                     # show running agents and active sessions
tgcc status --agent test                        # show specific agent status
```

### Control Socket Protocol (NDJSON over Unix socket)
```jsonc
// Request
{"type": "message", "text": "fix the tests", "agent": "test", "repo": "/path", "session": "uuid"}
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

**Goal:** Register new agents from CLI, not just by editing config JSON.

### CLI Interface
```
tgcc agent add myagent --bot-token <token> --repo ~/project
tgcc agent add myagent --bot-token <token>       # no default repo
tgcc agent remove myagent
tgcc agent list
tgcc agent repo myagent ~/new-project            # set/change default repo
```

### Behavior
- Writes to `~/.tgcc/config.json`
- Triggers hot-reload (config watcher picks it up)
- For `agent repo`: sets `defaults.repo` in the agent config. If agent has a default repo and user changes it via `/repo` in Telegram, the change lasts until session idle timeout, then reverts to default.

---

## 3. `/sessions` with Inline Buttons

**Goal:** Make sessions clickable for resume, show titles.

### Current
```
`a1b2c3d4` — 5 msgs, $0.0190 (2 min ago)
```

### Proposed
```
📋 Recent sessions:

1. `a1b2c3d4` — "Fix auth middleware" — 5 msgs, $0.02 (2 min ago)
   [Resume] [Delete]

2. `b2c3d4e5` — "Update tests" — 3 msgs, $0.01 (1h ago)
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
- **No session takeover detection:** If user opens the same session in VS Code or CLI, TGCC and the other client fight over the session.

### Proposed Changes

#### 4a. Smart Hang Detection (replace blunt 5-min timer)

Adopt OpenClaw's approach from `runner.ts`:

1. **Track CC state machine:**
   - `waitingForApiResponse`: between `message_stop` and next `message_start` — silence expected
   - `executingTool`: between `stop_reason: "tool_use"` and next `user` tool_result — silence expected
   - Only start hang timer when CC is in neither state (truly stuck)

2. **Check for active children:**
   ```typescript
   function hasActiveChildren(pid: number): boolean {
     try {
       execSync(`pgrep --parent ${pid}`, { stdio: 'ignore' });
       return true;
     } catch { return false; }
   }
   ```
   Before killing on hang timeout, check if CC has child processes (running bash commands, etc). If yes, extend the timeout.

3. **Hang timer flow:**
   ```
   CC produces output → reset hang timer
   Hang timer fires →
     if waitingForApiResponse || executingTool → don't kill, extend
     else if hasActiveChildren(cc.pid) → don't kill, extend by 5 min
     else → truly hung, kill with SIGTERM, wait 5s, SIGKILL if needed
   ```

#### 4b. Let CC Exit Naturally

**Principle:** Don't restart CC after timeouts. Let CC exit when it's done, and `--continue` on the next message.

Current behavior: On hang, TGCC kills CC then tells user "restarting...". This is wrong — if CC is hung, restarting it won't help. Better to:

1. Kill the hung process
2. Tell user "CC process was unresponsive and was stopped. Send a new message to continue."
3. On next user message, spawn with `--continue` using the same session ID

Remove the "restarting" language. The process died; the session lives on.

#### 4c. Session Takeover Detection

**Problem:** User opens CC in VS Code or terminal on the same session. TGCC's CC process gets confused or fails silently.

**Detection method:** CC uses a session lock file at `~/.claude/sessions/{sessionId}.lock` (or similar). When another client takes over:

1. CC may emit an error event about session conflict
2. CC may exit with a specific code
3. CC may simply stop producing output (looks like a hang)

**Proposed approach:**

1. **On CC exit with session conflict:** Parse the exit code/error. If it indicates session takeover:
   - Don't try to `--continue` — the session is owned by another client
   - Notify user: "Session was opened in another client. Send a new message to start fresh."
   - Clear the session from `SessionStore`

2. **Proactive check:** Before spawning CC with `--resume`, check if the session lock file exists and is held by another process:
   ```typescript
   function isSessionLocked(sessionId: string): boolean {
     const lockPath = path.join(os.homedir(), '.claude', 'sessions', sessionId, '.lock');
     // Check if lock file exists and if the holding PID is alive
   }
   ```

3. **On lock detection:** Start a fresh session instead of `--resume`.

### Implementation Notes

- State tracking (`waitingForApiResponse`, `executingTool`) requires parsing the stream-json events in `cc-protocol.ts`. The `assistant` events contain `stop_reason`, and `system` events with `subtype: "init"` mark the start.
- The `hasActiveChildren` check is a simple `pgrep --parent` — import `execSync` from `child_process`.
- Session lock path needs investigation — check CC source or test empirically what files CC creates per session.

---

## Priority Order

1. **4a. Smart hang detection** — highest impact, prevents false kills
2. **4b. Natural exit flow** — improves UX, removes misleading "restarting" message  
3. **3. /sessions buttons** — quick UX win
4. **1. CLI command** — enables BossBot/external integration
5. **2. Agent registration** — convenience, config editing works for now
6. **4c. Session takeover** — needs CC behavior investigation first
