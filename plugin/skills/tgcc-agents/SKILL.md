---
name: tgcc-agents
description: 'Manage TGCC agents (Claude Code via Telegram) using tgcc_spawn, tgcc_send, tgcc_status, tgcc_kill, tgcc_log tools. Use when: spawning CC sessions through TGCC, sending tasks to persistent TGCC bots, checking agent status/logs, killing sessions, or creating ephemeral agents for one-off work.'
homepage: https://github.com/botverse/tgcc
metadata:
  {
    "openclaw":
      {
        "emoji": "🔌",
        "requires": { "sockets": ["/tmp/tgcc/ctl/tgcc.sock"] },
        "install":
          [
            {
              "id": "npm",
              "kind": "npm",
              "package": "@fonz/tgcc",
              "label": "Install TGCC plugin",
            },
          ],
        "setup": "Install with `openclaw plugins install @fonz/tgcc`, then configure plugin with socketDir and defaultAgent.",
      },
  }
---

# TGCC Agents — OpenClaw Plugin

Manage **Claude Code sessions via TGCC** (Telegram ↔ Claude Code bridge) using five dedicated tools. TGCC manages CC processes with Telegram rendering — you get visibility in both OpenClaw and Telegram.

## Auto-Wake Events

The agent is automatically woken (receives a `[System Event]`) when the following events occur:

| Event | Wake condition |
|-------|---------------|
| `stuck` | Agent silent for too long |
| `failure_loop` | Consecutive failures |
| `build_result` | Build failed **or** first passing build (debounced: no wake if previous build also passed within 60s) |
| `git_commit` | Commit made (debounced: no wake if previous commit was <30s ago) |
| `task_milestone` | Agent reports progress milestone |
| `context_pressure` | Context window filling up |
| `budget_alert` | Cost threshold reached |
| `result` | CC session completed (always wakes) |

Events **not** waking the agent (pull-only): `subagent_spawn`, lifecycle events.

## Tools

### `tgcc_status` — Check what's running

```
tgcc_status                          # all agents
tgcc_status agentId="tgcc"           # specific agent
```

Returns:
- **agents**: list with repo, type (persistent/ephemeral), state (idle/active), plus per-agent `lastActivity` (ts + summary of last event) and `contextPercent` (last known context window %)
- **pendingResults**: completed CC results not yet consumed (use `drain=true` to consume)
- **pendingPermissions**: permission requests waiting for approval
- **recentEvents**: last events (cc_spawned, result, error, etc.)

### `tgcc_log` — View an agent's event log

```
tgcc_log agentId="tgcc"                          # last 30 lines
tgcc_log agentId="tgcc" limit=50                 # last 50 lines
tgcc_log agentId="tgcc" since=300000             # last 5 minutes
tgcc_log agentId="tgcc" grep="error|fail"        # filter by regex
tgcc_log agentId="tgcc" type="system"            # filter by entry type
tgcc_log agentId="tgcc" offset=100 limit=20      # paginate
```

Shows build results, commits, milestones, errors, and assistant output from the CC session's event buffer. Use this to check what an agent is working on **without waking it**.

Entry types: `text` (assistant output), `tool` (tool calls), `system` (events), `error`, `user` (messages sent to CC).

**When to use `tgcc_log` vs `tgcc_status`:**
- `tgcc_status` — broad overview: which agents are running, pending results, recent event summaries
- `tgcc_log` — deep dive: actual CC output, tool calls, build details for a specific agent

### `tgcc_spawn` — Start a CC session

**Existing agent** (persistent, has Telegram bot):
```
tgcc_spawn agentId="tgcc" task="Fix the render pipeline bug"
tgcc_spawn agentId="sentinella" task="Check tile coverage for Ibiza"
```

**Ephemeral agent** (one-off, no Telegram bot — requires `repo`):
```
tgcc_spawn agentId="my-task" repo="/home/user/project" task="Add error handling"
tgcc_spawn agentId="review-pr" repo="/tmp/pr-42" task="Review this PR" model="opus"
```

Optional params:
- `model`: override CC model (e.g. `opus`, `sonnet`)
- `permissionMode`: CC permission mode (`plan`, `default`, `bypassPermissions`)

### `tgcc_send` — Message an active agent

Send a follow-up message or new task to an agent that already has a CC session:
```
tgcc_send agentId="tgcc" text="Also run the tests"
tgcc_send agentId="sentinella" text="Now compare with last month"
```

If the agent is idle (no CC process), this spawns a new session. If active, the message is queued and sent to CC when it's ready for input.

**One-call session management + dispatch** (optional params apply before sending):
```
tgcc_send agentId="tgcc" text="start fresh task" newSession=true
tgcc_send agentId="tgcc" text="continue this" sessionId="abc12345..."
tgcc_send agentId="tgcc" text="big refactor" model="opus"
tgcc_send agentId="tgcc" text="plan it out" newSession=true model="opus"
```

- `newSession`: clear current session before sending (start fresh)
- `sessionId`: resume a specific session by ID before sending
- `model`: switch model before sending (kills current process)

### `tgcc_session` — Session management without sending

For session lifecycle operations that don't involve sending a message:
```
tgcc_session agentId="tgcc" action="list"                          # list recent sessions
tgcc_session agentId="tgcc" action="new"                           # clear session (next msg starts fresh)
tgcc_session agentId="tgcc" action="continue"                      # preserve session for auto-resume
tgcc_session agentId="tgcc" action="resume" sessionId="abc12345"   # set specific session to resume
tgcc_session agentId="tgcc" action="cancel"                        # cancel current turn (process stays alive)
tgcc_session agentId="tgcc" action="compact"                       # trigger context compaction
tgcc_session agentId="tgcc" action="compact" instructions="focus on streaming.ts"
tgcc_session agentId="tgcc" action="set_model" model="opus"        # switch model
tgcc_session agentId="tgcc" action="set_repo" repo="myproject"     # switch repo
tgcc_session agentId="tgcc" action="set_permissions" mode="acceptEdits"
```

`action="list"` returns sessions with id, title, age, lineCount, contextPct, model, isCurrent.

Permission modes: `dangerously-skip`, `acceptEdits`, `default`, `plan`

### `tgcc_kill` — Stop a CC session

```
tgcc_kill agentId="tgcc"                          # kill CC process, keep agent
tgcc_kill agentId="my-task" destroy=true           # kill CC + destroy ephemeral agent
```

## Typical Workflows

### Delegate a coding task
```
tgcc_spawn agentId="tgcc" task="Implement the OpenClaw plugin per specs/openclaw-plugin.md"
# ... wait ...
tgcc_status                    # check pendingResults for completion
```

### Multi-agent coordination
```
tgcc_send agentId="sentinella" text="Generate the fire risk report"
tgcc_send agentId="kyobot" text="Update the booking dashboard"
tgcc_status                    # see both working in parallel
```

### Ephemeral agent for isolated work
```
tgcc_spawn agentId="pr-review" repo="/tmp/pr-42" task="Review changes" model="opus"
# ... result comes back ...
tgcc_kill agentId="pr-review" destroy=true   # clean up
```

### Follow up on running work
```
tgcc_send agentId="tgcc" text="Also fix the edge case in splitMessage"
```

### Session management
```
tgcc_session agentId="tgcc" action="list"             # see available sessions
tgcc_session agentId="tgcc" action="cancel"           # interrupt running turn
tgcc_session agentId="tgcc" action="compact"          # compact context when approaching limit
tgcc_send agentId="tgcc" text="new task" newSession=true model="haiku"  # fresh session, different model
```

## How It Works

```
OpenClaw Plugin              TGCC Bridge                CC Process
  │                            │                          │
  │── send_message ───────────►│                          │
  │   {agentId, text}          │── spawn/resume CC ──────►│
  │◄── ack ───────────────────│   {sessionId, state}      │
  │                            │                          │
  │   (CC works, visible       │                          │
  │    in Telegram chat)       │                          │
  │                            │◄── result ───────────────│
  │◄── event: result ─────────│   {text, cost}            │
  │                            │                          │
```

- **Protocol**: NDJSON over Unix socket (default: `/tmp/tgcc/ctl/*.sock`)
- **Connection**: Plugin registers as supervisor, auto-reconnects with backoff
- **Discovery**: Agents auto-discovered on connect (persistent bots + ephemeral)
- **Events**: cc_spawned, result, process_exit, permission_request, api_error
- **Shared sessions**: Persistent agents share CC sessions with Telegram users — both see the same work

## Plugin Configuration

```json
{
  "plugins": {
    "entries": {
      "tgcc": {
        "enabled": true,
        "config": {
          "socketDir": "/tmp/tgcc/ctl",
          "defaultAgent": "tgcc",
          "telegramChatId": "7016073156"
        }
      }
    }
  }
}
```

- **socketDir**: where TGCC control sockets live (default: `/tmp/tgcc/ctl`)
- **defaultAgent**: fallback agentId when none specified
- **telegramChatId**: chat ID for permission request buttons
- **agents**: optional array of agent IDs to subscribe to (default: all)

## Permission Requests

When CC needs permission (file write, bash command, etc.), TGCC forwards it through the plugin. If `telegramChatId` is configured, approval buttons appear in Telegram (✅ Allow / ❌ Deny). Otherwise, permissions follow CC's configured `permissionMode`.

## When NOT to Use This

- **Quick file edits**: use the `edit` tool directly
- **Reading/exploring code**: use `read` / `exec` tools
- **Tasks needing full isolation from Telegram**: spawn CC directly via coding-agent skill
