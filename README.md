# @fonz/tgcc

**Telegram ↔ Claude Code bridge** — run Claude Code sessions from Telegram with full streaming, session management, and multi-agent support.

## Quick Start

```bash
npm install -g @anthropic-ai/claude-code
claude login

npm install -g @fonz/tgcc
tgcc init        # walks you through setup
tgcc run         # test in foreground
tgcc install     # install as a user service
```

## What it does

TGCC bridges the [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) to Telegram. Each Telegram bot becomes a full Claude Code client.

- **Streaming** — responses stream into a single message that updates in place
- **Sessions** — resume, switch, and list sessions. Roam between Telegram and the CC CLI on the same session
- **Multi-agent** — one bot per project, each with its own config and permissions
- **Permission relay** — CC permission prompts appear as inline buttons
- **MCP tools** — CC can send files, images, and voice back via built-in MCP server
- **Markdown → Telegram HTML** — code blocks, bold, italic, links, tables, all rendered properly
- **Usage stats** — per-turn token counts and cost

## Service Management

```bash
tgcc install     # Install & start as a user service (systemd/launchd)
tgcc start       # Start the service
tgcc stop        # Stop the service
tgcc restart     # Restart the service
tgcc uninstall   # Remove the service
tgcc logs        # Tail service logs
tgcc run         # Run in the foreground (no service)
```

## CLI Commands

```bash
# Setup
tgcc init                              # Interactive setup

# Agents
tgcc agent add mybot --bot-token <token>
tgcc agent remove mybot
tgcc agent rename mybot newname
tgcc agent list

# Repos
tgcc repo add .                        # Add current directory
tgcc repo add . --name=myrepo          # Add with explicit name
tgcc repo add ~/code/backend           # Add a path
tgcc repo remove --name=myrepo
tgcc repo assign --agent=mybot --name=myrepo
tgcc repo clear --agent=mybot
tgcc repo list

# Messaging (while service is running)
tgcc message "fix the login bug"
tgcc message "deploy" --agent=mybot --session=abc123
tgcc status
tgcc status --agent=mybot

# Permissions
tgcc permissions set mybot dangerously-skip
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message |
| `/new` | Start a fresh session |
| `/sessions` | List recent sessions with resume buttons |
| `/resume <id>` | Resume a session by ID |
| `/repo` | Switch repo with inline buttons |
| `/model <name>` | Switch model |
| `/permissions` | Set permission mode |
| `/status` | Process state, model, repo, cost |
| `/cancel` | Abort current CC turn |
| `/catchup` | Summarize external CC activity |

## Configuration

Config lives at `~/.tgcc/config.json` (created by `tgcc init`).

```jsonc
{
  "global": {
    "ccBinaryPath": "claude",
    "logLevel": "info"
  },
  "repos": {
    "myproject": "/home/user/myproject"
  },
  "agents": {
    "mybot": {
      "botToken": "123456:ABC-DEF...",
      "allowedUsers": [],
      "defaults": {
        "repo": "myproject",
        "permissionMode": "bypassPermissions"
      }
    }
  }
}
```

### Permission Modes

| Mode | Description |
|------|-------------|
| `dangerouslySkipPermissions` | Skip all prompts |
| `acceptEdits` | Auto-accept edits, prompt for commands |
| `default` | Full permission flow via inline buttons |
| `plan` | Plan-only, no tool execution |

## Architecture

```
User ──► Telegram ──► TGCC ──► Claude Code CLI (stream-json)
                        │
                  config.json ─── agents, repos, permissions
                  state.json ─── sessions, per-user overrides
```

TGCC runs as a persistent service. When a user sends a message, it spawns (or resumes) a Claude Code process using the `stream-json` protocol, streams the response back with edit-in-place updates.

Sessions are fully interoperable with the VS Code Claude Code extension — same `~/.claude/projects/` JSONL files.

## License

MIT
