# TGCC Spec Review — Gaps & Proposed Solutions

Review of ARCHITECTURE.md, PROTOCOL.md, TASKS.md. Each section identifies a gap and proposes a concrete fix.

---

## 1. Multi-Agent Architecture

### Gap

The config model in ARCHITECTURE.md is single-bot. One `botToken`, one `allowedUsers` list, one `defaults` block. TASKS.md mentions "multi-agent" but the data model isn't designed. For one TGCC instance to manage N agents (each a distinct TG bot + CC config + repo context), we need a proper config schema and internal routing model.

### Proposed Config Model

```json
{
  "global": {
    "ccBinaryPath": "claude",
    "mediaDir": "/tmp/tgcc/media",
    "socketDir": "/tmp/tgcc/sockets",
    "logLevel": "info",
    "stateFile": "~/.tgcc/state.json"
  },
  "agents": {
    "personal": {
      "botToken": "BOT_TOKEN_1",
      "allowedUsers": ["7016073156"],
      "defaults": {
        "model": "claude-opus-4-6",
        "repo": "/home/fonz/Projects",
        "maxTurns": 50,
        "idleTimeoutMs": 300000,
        "hangTimeoutMs": 300000,
        "permissionMode": "dangerously-skip"
      },
      "users": {
        "7016073156": {
          "model": "claude-opus-4-6",
          "repo": "/home/fonz/Botverse/tgcc"
        }
      }
    },
    "work": {
      "botToken": "BOT_TOKEN_2",
      "allowedUsers": ["7016073156", "98765"],
      "defaults": {
        "model": "claude-sonnet-4-20250514",
        "repo": "/home/fonz/Work",
        "maxTurns": 100
      }
    }
  }
}
```

### Internal Routing

The bridge's process map changes from `Map<userId, CCProcess>` to `Map<agentId:userId, CCProcess>`. Every inbound TG message carries the bot token it arrived on, which maps to an `agentId`. The composite key `agentId:userId` uniquely identifies a CC process.

```
TG message → (bot token → agentId) → (agentId + userId → CCProcess)
```

### Per-Agent Isolation

Each agent gets:
- Its own grammy `Bot` instance (separate polling loop)
- Its own MCP Unix socket: `{socketDir}/{agentId}.sock`
- Its own MCP config JSON: `/tmp/tgcc/mcp-{agentId}-{userId}.json`
- Session store namespaced under `agents.{agentId}.users.{userId}`

### Session Store (revised)

```json
{
  "agents": {
    "personal": {
      "users": {
        "7016073156": {
          "currentSessionId": "abc-123",
          "lastActivity": "2026-02-23T12:00:00Z",
          "model": "claude-opus-4-6",
          "repo": "/home/fonz/Botverse/tgcc"
        }
      }
    }
  }
}
```

### Implementation

- `AgentManager` class: owns the `Map<agentId, Agent>` where `Agent` holds the grammy bot, user configs, and CC process map.
- `Agent` class: encapsulates one bot's lifecycle (start/stop polling, handle messages, manage CC processes for its users).
- `Bridge` delegates to the correct `Agent` based on the incoming bot context.

---

## 2. Hot Reload

### Gap

Not designed anywhere in the specs. TASKS.md has a single checkbox: "Hot reload: watch config file, add/remove bots without restart." No design.

### Proposed Design

**Config watcher** using `fs.watch` on `~/.tgcc/config.json` with 1s debounce.

On change:
1. Parse new config, validate schema.
2. Diff against current running state (`AgentManager.currentConfig`).
3. For each agent:

| Change | Action |
|--------|--------|
| New agent added | Create `Agent`, start grammy bot, register commands |
| Agent removed | Graceful stop: kill all CC processes for agent, stop grammy bot, cleanup sockets |
| `botToken` changed | Full restart of that agent (stop old bot, start new) |
| `defaults` changed (model, repo, etc.) | Update in-memory config. Active CC processes keep old config; new spawns use new config |
| `allowedUsers` changed | Update in-memory allow list. Active sessions continue; new messages checked against new list |

**Graceful agent stop sequence:**
1. Stop grammy polling (no new messages)
2. For each active CC process: send SIGTERM, wait 5s, SIGKILL
3. Close MCP Unix socket
4. Remove agent from `AgentManager`

**Signal handling:**
- `SIGHUP` → trigger config reload (in addition to file watch)
- `SIGTERM` → graceful shutdown of all agents

### Edge Cases

- **Config parse error on reload**: Log error, keep running with old config. Send TG message to all admin users (first user in each agent's allowedUsers).
- **Bot token collision**: Reject config if two agents share a bot token.
- **Reload during active CC turn**: The CC process keeps running. Only new spawns pick up the new config.

---

## 3. Slash Commands

### Gap

ARCHITECTURE.md lists 7 basic commands. Missing: `/catchup`, `/cancel`, `/status` (detailed), `/help`, `/permissions`. No design for command registration with BotFather or argument parsing.

### Comprehensive Command Set

#### Status & Info

| Command | Description | Implementation |
|---------|-------------|----------------|
| `/status` | Process state, model, uptime, session ID, repo | Read from `CCProcess` state + agent config |
| `/cost` | Cumulative cost for current session | Track from `result` events (`total_cost_usd`) |
| `/help` | List all commands with descriptions | Static text, generated from command registry |
| `/ping` | Quick liveness check | Reply "pong" + process state (IDLE/ACTIVE/SPAWNING) |

**`/status` output example:**
```
Agent: personal
Process: ACTIVE (uptime: 12m)
Session: abc-123 (15 messages)
Model: claude-opus-4-6
Repo: /home/fonz/Botverse/tgcc
Cost: $0.42
```

#### Session Management

| Command | Description | Implementation |
|---------|-------------|----------------|
| `/new` | Kill current CC, spawn fresh (no `--continue`) | Kill process → clear session ID → next message spawns clean |
| `/sessions` | List recent sessions with timestamps | Read CC's session dir, show last 10 |
| `/resume <id>` | Resume a specific session | Kill current → store target ID → next spawn uses `--resume <id>` |
| `/session` | Current session ID + message count | Read from bridge state |

#### The `/catchup` Command

This is the key command. User worked in VS Code / terminal with CC outside TG, wants a summary.

**Implementation strategy:**

1. **Locate CC sessions.** CC stores sessions at:
   ```
   ~/.claude/projects/<project-path-slug>/sessions/<session-id>/
   ```
   The project slug is the repo path with `/` replaced by `-` and leading `-` (e.g., `/home/fonz/Botverse/tgcc` → `-home-fonz-Botverse-tgcc`). We know the user's configured repo, so we can derive the path.

2. **Identify "missed" sessions.** Compare each session's last-modified timestamp against the user's `lastActivity` in our session store. Sessions modified after `lastActivity` that we didn't initiate are "missed."

   Track which session IDs TGCC created/used. Any session ID not in our set but present in CC's session dir is an "external" session.

3. **Extract session content.** CC session directories contain conversation data. Read the session files and extract:
   - Assistant text messages (skip thinking blocks)
   - Tool names used (file list from Write/Edit, commands from Bash)
   - File paths touched
   - Total turns and cost if available

4. **Summarize.** Two tiers:
   - **Quick summary** (default): Parse locally, produce a structured summary:
     ```
     Session abc-123 (2h ago, 23 turns):
     • Edited: src/auth.ts, src/middleware.ts, tests/auth.test.ts
     • Ran: npm test (passed), npm run build
     • Topic: Added JWT authentication middleware
     ```
   - **Deep summary** (`/catchup --detail`): Spawn a one-shot CC process with the condensed transcript piped as context, ask it to summarize. Costs tokens but produces natural language.

5. **Edge case — no missed sessions**: Reply "You're up to date — no external CC activity since your last message."

**File discovery pseudocode:**
```typescript
function findMissedSessions(repo: string, lastActivity: Date): SessionInfo[] {
  const slug = repo.replace(/\//g, '-'); // e.g., "-home-fonz-Botverse-tgcc"
  const sessionsDir = path.join(homedir(), '.claude', 'projects', slug, 'sessions');
  const entries = fs.readdirSync(sessionsDir);
  return entries
    .map(id => ({ id, mtime: fs.statSync(path.join(sessionsDir, id)).mtime }))
    .filter(s => s.mtime > lastActivity)
    .filter(s => !tgccKnownSessions.has(s.id))
    .sort((a, b) => b.mtime - a.mtime);
}
```

#### Control Commands

| Command | Description | Implementation |
|---------|-------------|----------------|
| `/cancel` | Abort current CC turn | Send SIGINT to CC process. CC handles gracefully (stops current turn, emits partial result). Show "Cancelled." in TG. Process stays alive for next message. |
| `/model <name>` | Switch model for next spawn | Validate model name, store in user config. If CC is IDLE, takes effect on next spawn. If ACTIVE, takes effect after current process cycles. |
| `/repo <path>` | Switch working directory | Validate path exists. Store. Kill current CC process (different CWD needs new process). |
| `/permissions <mode>` | Set CC permission mode | Modes: `skip` (dangerously-skip-permissions), `default` (CC defaults). Stored per-user. |

#### Command Registration

Register commands with BotFather via grammy's `bot.api.setMyCommands()` at startup:

```typescript
await bot.api.setMyCommands([
  { command: 'new', description: 'Start a fresh session' },
  { command: 'sessions', description: 'List recent sessions' },
  { command: 'resume', description: 'Resume a session by ID' },
  { command: 'status', description: 'Process state and session info' },
  { command: 'cost', description: 'Show session cost' },
  { command: 'catchup', description: 'Summarize external CC activity' },
  { command: 'cancel', description: 'Abort current CC turn' },
  { command: 'model', description: 'Switch model' },
  { command: 'repo', description: 'Switch working directory' },
  { command: 'help', description: 'List all commands' },
]);
```

---

## 4. Streaming Integration

### Gap

ARCHITECTURE.md has a good streaming skeleton but doesn't address several edge cases: multi-block messages, mid-stream message splitting, markdown corruption, and tool-use interleaving.

### Detailed Streaming State Machine

```
                                    ┌──────────────────────┐
                                    │    IDLE              │
                                    │  (no TG message yet) │
                                    └──────────┬───────────┘
                                               │ message_start
                                               ▼
                                    ┌──────────────────────┐
                              ┌────►│   STREAMING          │◄────┐
                              │     │  (accumulating text)  │     │
                              │     └──────────┬───────────┘     │
                              │                │                  │
                     content_block_start        │           content_block_start
                     (type: text)               │           (next text block)
                              │                │                  │
                              │     ┌──────────▼───────────┐     │
                              │     │   TOOL_USE           │─────┘
                              │     │  (showing indicator)  │
                              └─────│                      │
                                    └──────────────────────┘
                                               │ message_stop
                                               ▼
                                    ┌──────────────────────┐
                                    │   DONE               │
                                    │  (final edit sent)   │
                                    └──────────────────────┘
```

### Multi-Block Assistant Messages

CC can emit assistant messages with multiple content blocks in a single turn: thinking → text → tool_use → text → tool_use → text. The streaming module must handle this:

```typescript
class StreamAccumulator {
  private tgMessageId: number | null = null;
  private buffer = '';
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
  private lastEditTime = 0;
  private thinkingIndicatorShown = false;

  onContentBlockStart(block: ContentBlock) {
    this.currentBlockType = block.type;
    if (block.type === 'thinking' && !this.thinkingIndicatorShown) {
      this.sendOrEdit('_Thinking..._');
      this.thinkingIndicatorShown = true;
    }
    if (block.type === 'tool_use') {
      this.appendIndicator(`\n_Using ${block.name}..._`);
    }
  }

  onTextDelta(text: string) {
    this.buffer += text;
    this.throttledEdit();
  }

  // Throttle: max 1 edit/sec, min 100 chars since last edit
  private throttledEdit() {
    const now = Date.now();
    if (now - this.lastEditTime < 1000) return;
    if (!this.tgMessageId) {
      // First text — send new message, replacing any thinking indicator
      this.tgMessageId = await sendMessage(this.buffer);
    } else {
      await editMessage(this.tgMessageId, this.buffer);
    }
    this.lastEditTime = now;
  }
}
```

### Mid-Stream Message Splitting (>4096 chars)

TG messages have a 4096-char limit. During streaming, the buffer can exceed this.

**Strategy:**
- When buffer approaches 4000 chars, finalize the current TG message (last edit).
- Send a new message for the overflow. Update `tgMessageId` to the new message.
- Continue streaming into the new message.
- On final `message_stop`, do a final edit on the last message.

The 4000 threshold (not 4096) leaves room for markdown formatting that might expand during rendering.

### Markdown Safety During Streaming

Partial markdown can break TG rendering (e.g., unclosed `` ``` `` code block). Mitigations:

1. **Before each edit**, scan the buffer for unclosed markdown constructs:
   - Odd number of `` ``` `` → append a closing `` ``` ``
   - Unclosed `*bold*` or `_italic_` → append closing marker
2. **Send the "safe" version** to TG but keep the raw buffer intact for next edit.
3. This is cosmetic — only affects intermediate edits, not the final message.

### TG Rate Limit Handling

Telegram's `editMessageText` returns 429 with `retry_after` on rate limit.

- On 429: back off for the specified duration, skip intermediate edits.
- Increase throttle interval dynamically (e.g., double it on each 429, reset after success).
- The final edit must always succeed — retry with backoff.

### Tool Use Indicators

When CC emits tool_use blocks during streaming:
- Append a status line to the current streamed message: `\n_Using Read on src/auth.ts..._`
- When the next text block starts, remove the indicator line and continue with real text.
- This keeps everything in one message flow rather than spawning separate status messages.

---

## 5. Permission Prompts & Interactive Tool Approval

### Gap

The spec mentions `--dangerously-skip-permissions` but doesn't address what happens without it. CC in default mode asks for permission before running Bash commands, writing files, etc. In `-p` mode with stream-json, these appear as system events that block the turn.

### Proposed Design

When not using `--dangerously-skip-permissions`, CC may emit permission request events. Handle them by surfacing to TG as inline keyboards:

```
CC wants to run:
  bash: rm -rf /tmp/old-cache

[Allow] [Allow All] [Deny]
```

Implementation:
1. Detect permission request events in the CC output stream.
2. Send a TG message with `InlineKeyboard` buttons.
3. On button callback: write the approval/denial to CC's stdin in the expected format.
4. Track a timeout (60s) — if user doesn't respond, auto-deny and notify.

For v1, recommend `--dangerously-skip-permissions` with a note in docs about the security trade-off. Add inline-keyboard approval as a v2 feature, but design the event detection now so the infrastructure is ready.

The `permissionMode` field in agent config controls this:
- `"dangerously-skip"` → pass `--dangerously-skip-permissions` (v1 default)
- `"prompt"` → surface permission requests to TG via inline keyboards (v2)
- `"allowlist"` → pass `--allowedTools` with a configured list (good middle ground)

---

## 6. Message Queuing & Batching

### Gap

The spec says "Queue incoming messages" during SPAWNING but doesn't address what happens when the user sends messages while CC is ACTIVE mid-turn, or sends multiple messages in rapid succession.

### Proposed Design

**During ACTIVE state:** CC's stream-json stdin accepts messages at any time. CC queues them internally and processes after the current turn. Writing directly to stdin is correct.

**Rapid-fire batching:** When multiple TG messages arrive within a short window, concatenate them rather than sending each as a separate CC turn:

```typescript
class MessageBatcher {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly BATCH_WINDOW_MS = 2000;

  addMessage(text: string) {
    this.pending.push(text);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.BATCH_WINDOW_MS);
    }
  }

  private flush() {
    const combined = this.pending.join('\n\n');
    this.pending = [];
    this.timer = null;
    this.writeToCC(combined);
  }
}
```

**During SPAWNING:** Queue all messages. When CC emits `system.init`, flush the queue as a single batched message.

**User awareness:** When a message is queued (CC is spawning), send a TG reaction or typing indicator so the user knows it was received.

---

## 7. MCP Server Reliability

### Gap

The MCP server (child of CC) connects to the bridge via Unix socket. If the bridge restarts, that socket connection breaks. The spec doesn't address reconnection.

### Proposed Design

**MCP server reconnect logic:**
- On socket disconnect, retry connection every 2s for 30s.
- If reconnect fails, MCP tools return errors to CC ("Bridge unavailable, file delivery disabled").
- CC continues working — MCP tools are optional, not critical path.

**Per-agent socket paths:**
- Pattern: `{socketDir}/{agentId}-{userId}.sock`
- This avoids collision when multiple agents serve the same user.
- Socket paths are written into the per-spawn MCP config JSON.

**Bridge restart recovery:**
- On startup, read `state.json` to discover running CC processes (PIDs).
- Recreate socket listeners. MCP servers reconnect automatically.
- If PIDs are stale (process already dead), clean up and mark as IDLE.

### MCP Config Generation (per spawn)

```typescript
function generateMcpConfig(agentId: string, userId: string): string {
  const config = {
    mcpServers: {
      tgcc: {
        command: 'node',
        args: [path.join(__dirname, 'mcp-server.js')],
        env: {
          TGCC_AGENT_ID: agentId,
          TGCC_USER_ID: userId,
          TGCC_SOCKET: path.join(socketDir, `${agentId}-${userId}.sock`)
        }
      }
    }
  };
  const configPath = `/tmp/tgcc/mcp-${agentId}-${userId}.json`;
  fs.writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}
```

---

## 8. Graceful Shutdown

### Gap

TASKS.md lists "Graceful shutdown" as a checkbox. No design.

### Proposed Design

On SIGTERM/SIGINT:
1. Stop all grammy bots (stop polling — no new messages accepted).
2. For each active CC process:
   a. Send SIGTERM.
   b. Wait up to 10s for process to exit.
   c. If still alive, SIGKILL.
3. Close all MCP Unix sockets.
4. Write final state to `state.json` (session IDs, last activity timestamps).
5. Exit.

The state file allows recovery on next startup — we know which sessions to `--continue`.

---

## 9. Cost Budget Enforcement

### Gap

The spec tracks cost from `result` events but doesn't enforce budgets. CC has `--max-budget-usd` but there's no TGCC-level budget per user or agent.

### Proposed Design

Add to agent config:
```json
{
  "budgets": {
    "perSession": 5.0,
    "perDay": 25.0,
    "perMonth": 200.0
  }
}
```

Implementation:
- Track cumulative cost per session (from `result.total_cost_usd`).
- Track daily/monthly cost in session store (reset on date boundary).
- When budget exceeded: refuse to spawn new CC process, notify user.
- Pass `--max-budget-usd` to CC as a safety net (per-session limit).

---

## 10. Reply Context & Thread Awareness

### Gap

TG messages can be replies to specific bot messages. The spec doesn't preserve this context. If the user replies to a specific CC response, that context is lost.

### Proposed Design

When a TG message is a reply to a bot message:
1. Look up the original message content from our message map (`Map<tgMessageId, ccContent>`).
2. Prepend context to the CC input: `"[Replying to: '<truncated original>']\n\n<user message>"`.
3. This gives CC context about what the user is referring to.

Keep a rolling buffer of the last 50 bot messages per chat for lookup. No persistence needed — if the bot restarts, reply context is lost (acceptable).

---

## 11. Missing TASKS.md Items

Based on this review, these tasks should be added:

```
## Agent Manager
- [ ] AgentManager class: load config, create/destroy Agent instances
- [ ] Config file watcher with debounced reload
- [ ] Config diffing (detect added/removed/changed agents)
- [ ] Per-agent grammy Bot lifecycle (start/stop)
- [ ] SIGHUP handler for manual config reload

## Message Handling
- [ ] Message batcher (2s window for rapid-fire messages)
- [ ] Message queue during SPAWNING state
- [ ] Reply context extraction from TG reply messages
- [ ] /cancel: SIGINT to CC process

## Catchup System
- [ ] CC session directory discovery (project slug computation)
- [ ] Session file parser (extract assistant text, tool names, files touched)
- [ ] External session detection (sessions not created by TGCC)
- [ ] Structured summary formatter
- [ ] Optional CC-powered deep summary

## Reliability
- [ ] MCP server reconnect logic
- [ ] Bridge state persistence (state.json)
- [ ] Bridge restart recovery (adopt orphan CC processes)
- [ ] Cost tracking and budget enforcement
- [ ] TG rate limit handling (429 backoff in streaming)

## Slash Commands (additions)
- [ ] /cancel — abort current turn
- [ ] /catchup — summarize external CC activity
- [ ] /ping — liveness check
- [ ] /permissions — set CC permission mode
- [ ] BotFather command registration at startup
```

---

## Summary of Priorities

| Priority | Item | Why |
|----------|------|-----|
| **P0** | Multi-agent config model | Foundation — everything depends on this |
| **P0** | Streaming state machine | Core UX — text must flow to TG correctly |
| **P0** | Slash command framework | User interface for all control operations |
| **P1** | `/catchup` | Key differentiating feature |
| **P1** | Message batching | Prevents wasted CC turns on rapid messages |
| **P1** | Hot reload | Ops necessity for multi-agent |
| **P1** | `/cancel` | Users need to abort runaway turns |
| **P2** | Cost budgets | Prevents bill shock |
| **P2** | MCP reconnect | Reliability under restarts |
| **P2** | Permission prompts via inline keyboards | Security without `--dangerously-skip-permissions` |
| **P3** | Reply context | Nice-to-have UX improvement |
