# @fonz/tgcc

**Telegram ↔ Claude Code bridge** — run Claude Code sessions from Telegram with full streaming, session management, and multi-agent support.

## Why TGCC?

Claude Code is powerful but lives in a terminal. TGCC gives it a **shared, visible interface** through Telegram.

**The problem**: When an AI agent spawns a Claude Code session, it's ephemeral and invisible. No one can watch it work. No one can jump in. When it finishes, the context is gone.

**What TGCC does**: Each CC session gets a Telegram bot that streams output in real-time — thinking, tool use, code edits — all in a single updating message. Multiple sources can share the same CC process:

- A **supervisor agent** delegates tasks to workers via MCP tools
- **You** watch it work in Telegram from your phone
- You can **jump in** mid-session to steer, approve permissions, or add context
- Workers can **spawn ephemeral sub-agents** and get results back synchronously

This turns Claude Code from a black-box subprocess into a **collaborative workspace** between humans and AI agents.

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
- **Scheduling** — cron jobs and heartbeats: run prompts on a schedule, one-shot timers, dynamic job management from Telegram
- **Supervisor protocol** — a designated supervisor agent manages workers via MCP tools, receives high-signal events, and coordinates multi-agent workflows

## Architecture

```
Telegram ──► TGCC Bridge ──► Claude Code CLI (stream-json)
                 │
CLI (ctl) ───────┤
                 │
MCP Server ──────┘ (Unix socket, per-agent)
```

### Agent Model

Each agent has:
- **One repo** — the project directory CC runs in
- **One CC process** (at most) — shared by all message sources (Telegram, supervisor, CLI)
- **One model** — the Claude model to use

Agents don't know about users. `allowedUsers` is a system-level ACL that gates which Telegram users can interact with the bot. All allowed users share the same agent state.

`sessionId` lives on the CC process, not the agent. When a process spawns, it either continues the last session (`--continue`) or resumes a specific one (`--resume <id>`).

### Supervisor Protocol

One agent is designated as the **supervisor** via config. It gets additional MCP tools to manage workers:

- **`tgcc_agents`** — discover all registered agents
- **`tgcc_send`** — send a message/task to any worker (spawns CC if needed, auto-tracks)
- **`tgcc_status`** — get worker state, context %, cost, last activity
- **`tgcc_kill`** — terminate a worker's CC process
- **`tgcc_session`** — full session lifecycle (list, new, resume, compact, set_model, set_repo, set_permissions)
- **`tgcc_track`** / **`tgcc_untrack`** — real-time event notifications with optional heartbeat
- **`tgcc_cron`** — runtime cron job management (add/list/remove/trigger)

All agents (not just supervisor) can use `tgcc_agents`, `tgcc_status`, `tgcc_send`, `tgcc_log`, `tgcc_spawn`, and `tgcc_destroy` — enabling workers to spawn ephemeral sub-agents and coordinate with each other.

### Ephemeral Agents

Any agent can spawn temporary agents via `tgcc_spawn` — no Telegram bot needed:

- **Fire & forget** — spawn with a message, returns immediately
- **Async wake** — use `tgcc_send` after spawn, get woken when the agent's turn completes
- **Sync (`waitForResult`)** — blocks until the ephemeral agent finishes, returns text output, auto-destroys

Ephemeral agents auto-destroy on timeout or session end.

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

### MCP Tools (CC → Telegram / Supervisor)

Every CC process gets these built-in MCP tools:

- **`send_file`** — send a file to the user on Telegram
- **`send_image`** — send an image with preview to Telegram
- **`send_voice`** — send a voice message to Telegram
- **`notify_parent`** — send a message to the parent/orchestrator (questions, blockers, progress)
- **`supervisor_exec`** — request command execution on the host
- **`supervisor_notify`** — send a notification through the supervisor

All agents also get these coordination tools:

- **`tgcc_agents`** — list all registered agents with IDs, repos, models, state
- **`tgcc_status`** — get status of worker agents (state, context%, cost, last activity)
- **`tgcc_send`** — send a message/task to a worker agent (spawns CC if needed)
- **`tgcc_log`** — read the event log for a worker agent
- **`tgcc_spawn`** — spawn an ephemeral agent (supports fire-and-forget, async wake, and sync `waitForResult`)
- **`tgcc_destroy`** — destroy an ephemeral agent

The supervisor agent additionally gets:

- **`tgcc_kill`** — kill a worker agent's CC process
- **`tgcc_session`** — manage session lifecycle (`list`, `new`, `cancel`, `set_model`, `continue`, `resume`, `compact`, `set_repo`, `set_permissions`)
- **`tgcc_track`** / **`tgcc_untrack`** — real-time high-signal event tracking with optional heartbeat
- **`tgcc_cron`** — runtime cron job management (add/list/remove/trigger)


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

**Session**

| Command | Description |
|---------|-------------|
| `/start` | Welcome message & register commands |
| `/new` | Start a fresh session |
| `/continue` | Respawn process, keep session |
| `/sessions` | List recent sessions with resume buttons |
| `/resume <id>` | Resume a session by ID |
| `/session` | Current session info |

**Info**

| Command | Description |
|---------|-------------|
| `/status` | Process state, model, repo, cost |
| `/cost` | Show session cost |
| `/catchup` | Summarize external CC activity |
| `/ping` | Liveness check |

**Control**

| Command | Description |
|---------|-------------|
| `/restart` | Restart the TGCC systemd service |
| `/cancel` | Abort current CC turn |
| `/compact [instructions]` | Compact conversation context |
| `/model <name>` | Switch model |
| `/permissions [mode]` | Set permission mode (buttons or inline) |
| `/repo` | Switch repo with inline buttons |
| `/repo help` | Repo management commands |
| `/repo add <name> <path>` | Register a repo |
| `/repo remove <name>` | Unregister a repo |
| `/repo assign <name>` | Set as agent default |
| `/repo clear` | Clear agent default |

**Cron**

| Command | Description |
|---------|-------------|
| `/cron list` | Show all scheduled jobs |
| `/cron add` | Add a new cron job (see flags below) |
| `/cron run <id>` | Trigger a job immediately |
| `/cron remove <id>` | Remove a dynamic job |

`/cron add` flags: `--every <interval>`, `--at <time>`, `--cron <expr>`, `--tz <zone>`, `--message <text>`, `--session main|isolated`, `--name <label>`, `--announce`

| | |
|---------|-------------|
| `/help` | Full command reference |

## Configuration

Config lives at `~/.tgcc/config.json` (created by `tgcc init`).

```jsonc
{
  "global": {
    "ccBinaryPath": "claude",       // path to claude CLI binary
    "mediaDir": "/tmp/tgcc/media",  // temp dir for media files
    "socketDir": "/tmp/tgcc/sockets", // MCP bridge sockets
    "ctlSocketDir": "/tmp/tgcc/ctl",  // control/supervisor socket
    "mcpConfigDir": "/tmp/tgcc",      // generated MCP config files
    "logLevel": "info",
    "stateFile": "~/.tgcc/state.json" // persisted session state
  },
  "repos": {
    "myproject": "/home/user/myproject"
  },
  "agents": {
    "mybot": {
      "botToken": "123456:ABC-DEF...",
      "allowedUsers": ["your-telegram-id"],
      "defaults": {
        "repo": "myproject",                      // key from repos map, or absolute path
        "model": "claude-sonnet-4-20250514",
        "permissionMode": "dangerously-skip",     // see modes below
        "maxTurns": 50,                           // max turns per session
        "idleTimeoutMs": 7200000,                 // kill idle process after 2h
        "hangTimeoutMs": 300000,                  // kill hung process after 5m
        "ccExtraArgs": "--verbose"                // extra CLI args for CC (optional)
      },
      "users": {                                  // per-user overrides (optional)
        "123456789": { "model": "claude-opus-4-20250514" }
      },
      "heartbeat": {                              // periodic prompt (optional)
        "intervalMins": 30,                       // 5, 10, 15, 30, or 60
        "prompt": "Check on running tasks",
        "onlyWhenIdle": true,                     // skip if agent is mid-turn
        "tz": "America/New_York"                  // IANA timezone
      }
    }
  },
  "supervisor": "mybot",                          // agent ID for native supervisor (null = disabled)
  "cron": {                                       // scheduled jobs (optional)
    "jobs": [
      {
        "id": "daily-standup",
        "name": "Standup",
        "schedule": "0 9 * * 1-5",               // standard cron expression
        "tz": "Europe/Madrid",
        "agentId": "mybot",
        "message": "Run the daily standup",
        "session": "main",                        // "main" or "isolated"
        "announce": true,                         // post TG message on fire
        "model": "claude-sonnet-4-20250514",      // model override (isolated only)
        "timeoutMs": 300000,                      // timeout (isolated only)
        "deleteAfterRun": false                   // one-shot job
      }
    ]
  }
}
```

### Permission Modes

| Mode | Description |
|------|-------------|
| `dangerously-skip` | Skip all prompts |
| `acceptEdits` | Auto-accept edits, prompt for commands |
| `default` | Full permission flow via inline buttons |
| `plan` | Plan-only, no tool execution |

## License

MIT
