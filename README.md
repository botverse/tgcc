# @fonz/tgcc

**Telegram ↔ Claude Code bridge** — run Claude Code sessions from Telegram with full streaming, inline editing, and multi-agent support.

## What is TGCC?

TGCC bridges the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) to Telegram, turning any Telegram bot into a full Claude Code client.

- **Streaming output** — CC responses stream into a single Telegram message that updates in place (no message spam)
- **Multi-agent** — run one bot per project/repo, each with its own config, model, and permissions
- **Session management** — resume, switch, and list sessions with inline keyboard buttons
- **Permission relay** — CC permission prompts appear as inline buttons (Allow / Deny / Allow All)
- **Thinking display** — thinking content shown as expandable blockquotes (collapsible in Telegram)
- **Sub-agent threading** — sub-agent tool calls appear as threaded replies to the main message
- **Staleness detection** — detects when a session was modified externally (e.g. from VS Code) and reconnects
- **Usage stats** — per-turn token counts and cost shown as a subtle footer
- **CLI tool** — send messages from your terminal, manage agents and repos
- **HTML formatting** — code blocks with syntax highlighting, bold, italic, links

## Architecture

```
User ──► Telegram ──► TGCC ──► Claude Code CLI (stream-json)
                      │
              config.json (agents, repos, permissions)
              state.json (sessions, models, per-user overrides)
```

TGCC runs as a persistent service. Each configured agent connects to its own Telegram bot. When a user sends a message, TGCC spawns (or reuses) a Claude Code process using the `stream-json` protocol, forwards the message, and streams the response back to Telegram with edit-in-place updates.

**Key design decisions:**
- **Config-driven** — everything in `~/.tgcc/config.json`, hot-reloaded on changes
- **Unix sockets** — CLI communicates with the running service via per-agent sockets in `/tmp/tgcc/ctl/`
- **MCP bridge** — CC can send files, images, and voice back to the user via a built-in MCP server
- **State-aware hang detection** — distinguishes between API waits, tool execution (checks child processes), and real hangs

## Quick Start

```bash
# Install
npm install -g @fonz/tgcc

# Create a Telegram bot via @BotFather, get the token

# Register an agent
tgcc agent add mybot --bot-token 123456:ABC-DEF --repo ~/myproject

# Start the service
tgcc

# Send your bot a message on Telegram!
```

## Configuration

Config lives at `~/.tgcc/config.json`. TGCC creates it automatically when you run `tgcc agent add`.

```jsonc
{
  "global": {
    "ccBinaryPath": "claude",     // Path to claude CLI binary
    "logLevel": "info",
    "mediaDir": "~/.tgcc/media",
    "socketDir": "/tmp/tgcc",
    "stateFile": "~/.tgcc/state.json"
  },
  "repos": {
    "myproject": "/home/user/myproject",
    "backend": "/home/user/backend"
  },
  "agents": {
    "mybot": {
      "botToken": "123456:ABC-DEF...",
      "allowedUsers": ["123456789"],  // Telegram user IDs
      "defaults": {
        "model": "claude-sonnet-4-20250514",
        "repo": "myproject",
        "permissionMode": "acceptEdits",
        "maxTurns": 30,
        "idleTimeoutMs": 600000,
        "hangTimeoutMs": 300000
      }
    }
  }
}
```

### Permission Modes

| Mode | Description |
|------|-------------|
| `dangerously-skip` | Skip all permission prompts (⚠️ use with care) |
| `acceptEdits` | Auto-accept file edits, prompt for everything else |
| `default` | CC's built-in permission flow — prompts appear as inline buttons in Telegram |
| `plan` | Plan-only mode, no tool execution |

### Repo Registry

Repos are named shortcuts for project paths. Register them once, use everywhere:

```bash
tgcc repo add myproject ~/code/myproject
tgcc repo add backend ~/code/backend
tgcc repo assign mybot myproject    # Set as agent's default
```

In Telegram, `/repo` shows an inline keyboard to switch repos on the fly.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message, register bot commands |
| `/help` | List all commands |
| `/new` | Start a fresh session |
| `/sessions` | List recent sessions with Resume/Delete buttons |
| `/resume <id>` | Resume a session by ID |
| `/session` | Current session info |
| `/status` | Process state, model, repo, uptime, cost |
| `/cost` | Show session cost |
| `/model <name>` | Switch model (takes effect on next spawn) |
| `/permissions` | Set permission mode with inline buttons |
| `/repo` | Switch repo with inline buttons |
| `/cancel` | Abort current CC turn (sends SIGINT) |
| `/catchup` | Summarize external CC activity on the same repo |
| `/ping` | Liveness check |

### Examples

**Start a conversation:**
> You: Fix the auth middleware to handle expired tokens

> Bot:
> <blockquote expandable>💭 Thinking<br>Looking at the auth middleware...</blockquote>
>
> I've updated `src/middleware/auth.ts` to handle expired tokens gracefully...
>
> *↩️ 1.2k in · 450 out · $0.0034*

**Permission prompt (when not using bypass mode):**
> 🔐 CC wants to use `Write`
> ```{"file_path": "src/auth.ts", ...}```
>
> `[✅ Allow]` `[❌ Deny]` `[✅ Allow All]`

**Switch repos:**
> `/repo`
>
> Current repo: `~/myproject`
>
> `[myproject]`
> `[backend]`
> `[➕ Add]` `[❓ Help]`

## CLI Commands

The `tgcc` CLI communicates with the running service via Unix sockets.

```bash
# Start the service (foreground)
tgcc

# Send a message to a running agent
tgcc message "fix the login bug" --agent mybot
tgcc msg "deploy to staging" --agent mybot --session abc123

# Check status
tgcc status
tgcc status --agent mybot

# Agent management
tgcc agent add mybot --bot-token <token> --repo ~/project
tgcc agent remove mybot
tgcc agent rename mybot newname
tgcc agent list
tgcc agent repo mybot backend    # Set default repo

# Repo management
tgcc repo add myproject ~/code/myproject
tgcc repo remove myproject
tgcc repo assign mybot myproject
tgcc repo clear mybot
tgcc repo list

# Permissions
tgcc permissions set mybot dangerously-skip
```

## Features in Detail

### Streaming with Edit-in-Place

CC output streams into a single Telegram message. As CC produces text, TGCC edits the same message with the accumulated content (throttled to ~1 edit/second to respect Telegram rate limits). When the message gets too long (~4000 chars), it splits into a new message.

### HTML Formatting

All output uses Telegram's HTML parse mode:
- Code blocks → `<pre><code class="language-python">...</code></pre>`
- Inline code → `<code>...</code>`
- Bold, italic, strikethrough, links — all converted from CC's markdown

### Thinking in Expandable Blockquotes

When CC thinks, the thinking content is captured and displayed as a collapsible blockquote:

```html
<blockquote expandable>💭 Thinking
Analyzing the auth middleware pattern...
</blockquote>
```

Users can tap to expand and see what CC was thinking.

### Sub-Agent Activity

When CC spawns sub-agents (via `dispatch_agent`, `Task`, etc.), TGCC sends a threaded reply:

> 🔄 Sub-agent spawned: `dispatch_agent`
> *(updates with input preview, then ✅ on completion)*

### Smart Hang Detection

TGCC tracks CC's activity state and checks for active child processes before declaring a hang:
- **Tool executing** with active children → extend timer
- **Waiting for API** → extend timer (API can be slow)
- **No activity** for hangTimeoutMs → truly hung, kill and notify

### Session Staleness Detection

If you use the same CC session from both Telegram and VS Code, TGCC detects the modification when you next message from Telegram. It shows a summary of what happened externally and reconnects cleanly.

## How It Works with Claude Code

TGCC uses CC's `stream-json` protocol:

1. **Spawn** — `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages`
2. **Initialize** — Send `control_request` with `subtype: "initialize"` (SDK handshake)
3. **Messages** — Write JSON user messages to stdin, parse NDJSON events from stdout
4. **Streaming** — `stream_event` wraps inner events: `message_start`, `content_block_start`, `content_block_delta` (text, thinking, image), `content_block_stop`, `message_stop`
5. **Permissions** — CC sends `control_request` with `subtype: "can_use_tool"`, TGCC relays to Telegram and sends `control_response` back
6. **Sessions** — `--resume <id>` reconnects to an existing session, same JSONL files as the VS Code extension
7. **Results** — `result` event with cost, token usage, success/error status

Sessions are fully interoperable with the VS Code Claude Code extension — the same `~/.claude/projects/` JSONL files are used by both.

## Project Structure

```
src/
├── cli.ts           # CLI tool (tgcc command)
├── bridge.ts        # Core orchestrator (TG ↔ CC)
├── cc-process.ts    # CC process lifecycle management
├── cc-protocol.ts   # CC stream-json protocol types & parser
├── streaming.ts     # Stream accumulator (edit-in-place, splitting)
├── telegram.ts      # Telegram bot (grammY)
├── config.ts        # Config loading, validation, hot-reload
├── session.ts       # Session store, staleness, catchup
├── ctl-server.ts    # Unix socket server for CLI communication
├── mcp-bridge.ts    # MCP server for CC → TG file/image/voice
├── mcp-server.ts    # MCP tool definitions
└── index.ts         # Entry point
```

## License

MIT
