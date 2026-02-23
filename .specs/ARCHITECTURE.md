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
7. **`src/output.ts`** — Output handler. Watches for CC file writes, sends files back to TG.

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

**v1: Wait for full turn, send once.** Streaming can be v2.

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
| File write (Write tool to `/tmp/tgcc/output/`) | Detect path, send as TG document |
| Code blocks | Format with TG markdown code blocks |
| Long text (>4096 chars) | Split into multiple messages |

### Output Directory Convention

CC writes files to `/tmp/tgcc/output/<user_id>/`. The bridge:
1. Watches this directory (fs.watch or poll after each turn)
2. On new file: send to TG as document
3. Clean up after sending

Alternatively: parse CC's tool_use events for Write tool calls — if the path is in the output dir, auto-send to TG. This is more reliable than fs.watch.

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

## Non-Goals (v1)

- Multi-user concurrency (v1 is single-user, single-process)
- Streaming/partial message edits on TG (v2)
- Mobile app / API server (future — will need WebSocket layer)
- MCP tool forwarding (not needed, CC has its own tools)
- Authentication beyond allowedUsers list
- Conversation compaction / context management (CC handles this)

## Future (v2+)

- **Streaming**: Edit TG messages as CC streams text
- **Multi-user**: Process pool, per-user isolation
- **Mobile app**: WebSocket API alongside TG
- **Sync**: Session history sync between TG and mobile app
- **Inline buttons**: Approval prompts for CC tool use (like permission mode)
- **Voice**: Whisper transcription → CC → TTS response
- **Group chat**: Bot in TG groups, mention-triggered
