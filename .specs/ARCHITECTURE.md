# TGCC — Telegram ↔ Claude Code Bridge

## Overview

A minimal server that bridges Telegram bot messages to persistent Claude Code CLI processes. One CC process per user, kept alive between messages, with session management and media piping.

## Core Concept

```
Telegram Bot API ←→ TGCC Server ←→ Claude Code CLI (stream-json stdin/stdout)
```

- **Inbound**: TG message → construct stream-json user message → write to CC stdin
- **Outbound**: CC stdout NDJSON stream → parse assistant messages → send to TG
- **Lifecycle**: CC process stays alive between messages. On idle timeout, process exits. Next message spawns with `--continue` to resume the session.

## Architecture

### Components

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│  Telegram    │     │    TGCC      │     │  Claude Code    │
│  Bot API     │◄───►│   Server     │◄───►│  CLI Process    │
│              │     │              │     │  (stream-json)  │
└─────────────┘     └──────────────┘     └─────────────────┘
                           │
                    ┌──────┴──────┐
                    │  Session    │
                    │  Store      │
                    │  (JSON)     │
                    └─────────────┘
```

### Module Breakdown

1. **`src/telegram.ts`** — Telegram bot (grammy). Receives messages, downloads media, routes to bridge.
2. **`src/bridge.ts`** — Core orchestrator. Maps users → CC processes. Handles message routing.
3. **`src/cc-process.ts`** — CC process lifecycle. Spawn, stdin/stdout piping, idle timeout, respawn with `--continue`.
4. **`src/cc-protocol.ts`** — Stream-json NDJSON protocol. Parse CC output events, construct user input messages.
5. **`src/session.ts`** — Session store. Track active session ID per user, list/switch sessions.
6. **`src/config.ts`** — Configuration (bot token, CC binary path, timeouts, allowed users, repos).
7. **`src/mcp-server.ts`** — MCP stdio server exposing `send_file`, `send_image`, `send_voice` tools to CC.
8. **`src/mcp-bridge.ts`** — IPC layer between MCP server process and main bridge (Unix socket).

## Protocol Details

### Input (TG → CC)

User messages are written to CC's stdin as NDJSON:

```json
{"type":"user","message":{"role":"user","content":"hello"},"uuid":"<uuid>"}
```

With images (base64 content blocks — **confirmed working**):

```json
{
  "type":"user",
  "message":{
    "role":"user",
    "content":[
      {"type":"text","text":"What's in this image?"},
      {"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"<base64>"}}
    ]
  },
  "uuid":"<uuid>"
}
```

With documents — save to disk, reference in text:

```json
{
  "type":"user",
  "message":{
    "role":"user",
    "content":"User sent a document: /tmp/tgcc/media/<filename>. Read and process it."
  },
  "uuid":"<uuid>"
}
```

### Output (CC → TG)

CC emits NDJSON lines on stdout. Key event types:

| Type | Subtype | Action |
|------|---------|--------|
| `system` | `init` | Session initialized — store session_id |
| `assistant` | — | Parse `.message.content[]` for text blocks → send to TG |
| `tool_use` | — | CC is using a tool — optionally show typing indicator |
| `tool_result` | — | Tool completed — continue waiting for assistant |
| `result` | `success` | Turn complete — finalize, report cost if configured |
| `result` | `error` | Error — send error message to TG |

### Streaming

CC streams assistant text incrementally. For TG:
- Buffer text until a natural break (sentence end, newline, or 2s timeout)
- Send as a single TG message, then edit it as more text arrives (like OpenClaw's partial streaming)
- Or: wait for full turn completion, send once (simpler, v1)

**Streaming is confirmed working.** CC emits `stream_event` NDJSON lines with `content_block_delta` containing text deltas — same format as the raw Anthropic API. Use `--include-partial-messages` flag.

Stream protocol:
1. `message_start` → response begins
2. `content_block_start` (type: "thinking") → show "🤔 Thinking..." on TG
3. `content_block_delta` (thinking) → skip/ignore content
4. `content_block_stop` → thinking done
5. `content_block_start` (type: "text") → replace thinking indicator, start accumulating
6. `content_block_delta` (type: "text_delta") → accumulate `.delta.text` chunks
7. Every ~500ms or ~200 chars, edit TG message with accumulated text
8. `content_block_stop` + `message_stop` → final edit, done

TG edit-streaming (like OpenClaw):
- First text chunk → `sendMessage` → store message_id
- Subsequent chunks → `editMessageText` with accumulated text (throttle to avoid TG rate limits: max 1 edit/sec)
- Final → last edit with complete text

## Process Lifecycle

### Spawn

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --no-session-persistence=false \
  [--continue | --resume <session-id>] \
  [--model <model>] \
  [--max-turns 50] \
  [--add-dir <repo-path>]
```

### States

```
IDLE ──(TG message)──→ SPAWNING ──(init event)──→ ACTIVE
  ↑                                                  │
  │                                                  │
  └──────────(idle timeout / result event)───────────┘
```

- **IDLE**: No CC process running. Next message spawns one.
- **SPAWNING**: CC is starting up. Queue incoming messages.
- **ACTIVE**: CC is processing. Write messages to stdin as they arrive.
- After a `result` event, start idle timer. If no new message within timeout → kill process → IDLE.
- Next message after IDLE: spawn with `--continue` to resume last session.

### Idle Timeout

Default: 5 minutes. Configurable. On timeout:
1. Kill CC process (SIGTERM, then SIGKILL after 5s)
2. Store session_id for `--continue`/`--resume`
3. Transition to IDLE

### Error Recovery

- CC process crashes → log error, transition to IDLE, next message respawns
- CC hangs (no output for 5 min during active turn) → kill, notify user, respawn
- TG webhook/polling errors → retry with backoff

## Session Management

### Commands

| Command | Action |
|---------|--------|
| `/new` | Start a fresh session (no `--continue`) |
| `/sessions` | List recent sessions (from CC's session store) |
| `/resume <id>` | Resume a specific session by ID |
| `/session` | Show current session info |
| `/model <name>` | Switch model for next spawn |
| `/repo <path>` | Set working directory for CC |
| `/cost` | Show accumulated cost for current session |

### Session Store

Simple JSON file at `~/.tgcc/sessions.json`:

```json
{
  "users": {
    "7016073156": {
      "currentSessionId": "abc-123",
      "lastActivity": "2026-02-23T12:00:00Z",
      "model": "claude-sonnet-4-20250514",
      "repo": "/home/fonz/Projects/myapp",
      "sessions": [
        {
          "id": "abc-123",
          "startedAt": "2026-02-23T11:00:00Z",
          "summary": "Working on API endpoints",
          "messageCount": 15
        }
      ]
    }
  }
}
```

## Media Handling

### Inbound (TG → CC)

| TG Type | CC Handling |
|---------|-------------|
| Text | Plain text content string |
| Photo | Download → base64 → image content block (confirmed working) |
| Document (PDF, etc.) | Download → save to `/tmp/tgcc/media/` → reference in text |
| Voice/Audio | Download → save to disk → reference in text (CC can't process audio, but can see the path) |
| Sticker | Ignore or convert to emoji description |
| Video | Download → save to disk → reference in text |

### Outbound (CC → TG)

| CC Output | TG Handling |
|-----------|-------------|
| Text (assistant message) | Send as TG message (markdown) |
| `send_file` MCP tool call | Send file as TG document |
| `send_image` MCP tool call | Send image as TG photo (with preview) |
| `send_voice` MCP tool call | Send as TG voice note |
| Code blocks | Format with TG markdown code blocks |
| Long text (>4096 chars) | Split into multiple messages |

File output is **explicit** — CC calls the `send_file`/`send_image` MCP tools when it wants to deliver something to the user. No directory watching or heuristics needed.

## Configuration

`~/.tgcc/config.json`:

```json
{
  "botToken": "...",
  "allowedUsers": ["7016073156"],
  "ccBinaryPath": "claude",
  "defaults": {
    "model": "claude-sonnet-4-20250514",
    "repo": "/home/fonz/Projects",
    "maxTurns": 50,
    "idleTimeoutMs": 300000,
    "hangTimeoutMs": 300000
  },
  "users": {
    "7016073156": {
      "model": "claude-opus-4-6",
      "repo": "/home/fonz/Botverse/tgcc"
    }
  }
}
```

## Tech Stack

- **Runtime**: Node.js (>=20)
- **Language**: TypeScript
- **TG Library**: grammy
- **Process management**: Node child_process (spawn)
- **NDJSON parsing**: readline (line-by-line from stdout)
- **Build**: tsup or tsc
- **Package manager**: pnpm

## MCP Tools (TGCC → CC)

TGCC runs a local MCP server that CC connects to. This gives CC tools to interact with the user's TG chat.

### `send_file`

Send a file to the user on Telegram.

```json
{
  "name": "send_file",
  "description": "Send a file to the user on Telegram. Use this when you want to deliver a file (image, PDF, code, etc.) to the user.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute path to the file to send" },
      "caption": { "type": "string", "description": "Optional caption for the file" }
    },
    "required": ["path"]
  }
}
```

When CC calls this tool:
1. Bridge reads the file at `path`
2. Sends it to the user's TG chat as a document (or photo if image)
3. Returns success/error to CC

### `send_image`

Send an image with optional caption (sent as TG photo, not document — better preview).

```json
{
  "name": "send_image",
  "description": "Send an image to the user on Telegram with a nice preview. Use for generated charts, screenshots, diagrams.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Absolute path to the image file" },
      "caption": { "type": "string", "description": "Optional caption" }
    },
    "required": ["path"]
  }
}
```

### `send_voice`

Send a voice message (TG voice note).

```json
{
  "name": "send_voice",
  "description": "Send a voice message to the user on Telegram.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path": { "type": "string", "description": "Path to .ogg opus audio file" },
      "caption": { "type": "string", "description": "Optional caption" }
    },
    "required": ["path"]
  }
}
```

### MCP Server Implementation

The MCP server runs as a stdio transport that CC connects to via `--mcp-config`:

```json
{
  "mcpServers": {
    "tgcc": {
      "command": "node",
      "args": ["<path>/dist/mcp-server.js"],
      "env": {
        "TGCC_USER_ID": "<telegram_user_id>",
        "TGCC_SOCKET": "/tmp/tgcc/bridge.sock"
      }
    }
  }
}
```

The MCP server communicates back to the bridge process via Unix socket (or IPC) to trigger the actual TG sends. This keeps the MCP server stateless — it just forwards tool calls to the bridge.

### CC Spawn with MCP

```bash
claude -p \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --mcp-config /tmp/tgcc/mcp-config.json \
  [--continue]
```

## Out of Scope

- Mobile app / API server (future — will need WebSocket layer)
- MCP tool forwarding (not needed, CC has its own tools)
- Conversation compaction / context management (CC handles this)

## Future

- **Mobile app**: WebSocket API alongside TG
- **Sync**: Session history sync between TG and mobile app
- **Inline buttons**: Approval prompts for CC tool use (like permission mode)
- **Voice**: Whisper transcription → CC → TTS response
- **Group chat**: Bot in TG groups, mention-triggered
