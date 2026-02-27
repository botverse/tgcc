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
- **Multi-agent** — run dedicated bots per project, each with its own repo and model
- **Permission relay** — CC permission prompts appear as inline buttons
- **MCP tools** — CC can send files, images, and voice back via built-in MCP server
- **Markdown → Telegram HTML** — code blocks, bold, italic, links, tables, all rendered properly
- **Usage stats** — per-turn token counts and cost
- **Supervisor protocol** — external orchestrators (e.g. OpenClaw) can send messages, subscribe to events, and share the same CC process via Unix socket

## Architecture

```
Telegram ──► TGCC Bridge ──► Claude Code CLI (stream-json)
                 │
CLI (ctl) ───────┤
                 │
Supervisor ──────┘ (Unix socket, NDJSON)
```

### Agent Model

Each agent has:
- **One repo** — the project directory CC runs in
- **One CC process** (at most) — shared by all message sources (Telegram, supervisor, CLI)
- **One model** — the Claude model to use

Agents don't know about users. `allowedUsers` is a system-level ACL that gates which Telegram users can interact with the bot. All allowed users share the same agent state.

`sessionId` lives on the CC process, not the agent. When a process spawns, it either continues the last session (`--continue`) or resumes a specific one (`--resume <id>`).

### Supervisor Protocol

External systems connect to TGCC's control socket (`/tmp/tgcc/ctl/tgcc.sock`) and register as a supervisor. They can then:

- **`send_message`** — send a message to any agent's CC process (spawns if needed)
- **`send_to_cc`** — write directly to an active CC process's stdin
- **`subscribe`** / **`unsubscribe`** — observe an agent's events
- **`status`** — list all agents, their state, and active processes
- **`kill_cc`** — terminate an agent's CC process

Events forwarded to subscribers: `result`, `session_takeover`, `process_exit`, `cc_spawned`, `state_changed`, `bridge_started`, plus all observability events.

When a supervisor sends a message to a persistent agent, a system notification (`🦞 OpenClaw: ...`) appears in the Telegram chat.

### Ephemeral Agents

Supervisors can create temporary agents for one-off tasks — no Telegram bot needed:

- **`create_agent`** — create an in-memory agent with a repo and model
- **`destroy_agent`** — tear down when the task is done

Ephemeral agents auto-destroy on timeout. Only the supervisor can interact with them.

### Observability

TGCC detects high-signal events from CC processes and forwards them to subscribers:

- **Build/test results** — pass/fail with error counts
- **Git commits** — commit messages as natural progress summaries
- **Context pressure** — alerts at 50%, 75%, 90% of context window
- **Failure loops** — 3+ consecutive tool failures
- **Stuck detection** — no CC output for 5+ minutes
- **Task milestones** — TodoWrite progress tracking
- **Sub-agent spawns** — CC using Task tool for parallel work

Each agent's events are stored in a ring buffer, queryable via `get_log` with offset/limit/grep/since/type filters.

### MCP Tools for CC → Supervisor

CC processes can communicate back to the orchestrator via built-in MCP tools:

- **`notify_parent`** — send a message to the parent (questions, blockers, progress)
- **`supervisor_exec`** — request command execution on the host
- **`supervisor_notify`** — send a notification to any agent

See [`docs/SPEC-SUPERVISOR-PROTOCOL.md`](docs/SPEC-SUPERVISOR-PROTOCOL.md) for the full protocol spec.
See [`docs/SPEC-SUBAGENT-OBSERVABILITY.md`](docs/SPEC-SUBAGENT-OBSERVABILITY.md) for the observability spec.

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
tgcc message "deploy" --agent=mybot
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
      "allowedUsers": ["your-telegram-id"],
      "defaults": {
        "repo": "myproject",
        "model": "claude-sonnet-4-20250514",
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

## License

MIT
