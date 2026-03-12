# SPEC: Heartbeat & Cron Scheduling

## Overview

Two complementary scheduling primitives built into the TGCC bridge daemon:

- **Heartbeat** — periodic, clock-aligned turns in an existing agent session
- **Cron** — arbitrary scheduled jobs (cron expression, one-shot, or interval), either injected into an existing session or run in an isolated ephemeral session

The bridge is the scheduler. No system crontab, no external tools.

---

## Clock Alignment

All heartbeat intervals fire "on the dot" — at clock boundaries, not N ms from startup. This is handled natively by cron expressions via `croner`.

Allowed intervals (minutes) and their cron expressions:

| `intervalMins` | Cron expression |
|---------------|-----------------|
| 5  | `*/5 * * * *`  |
| 10 | `*/10 * * * *` |
| 15 | `*/15 * * * *` |
| 30 | `*/30 * * * *` |
| 60 | `0 * * * *`    |

Example: startup at 13:47 with `intervalMins: 15` → croner fires at 14:00, 14:15, 14:30, …

Both heartbeat and cron jobs use `croner`. No manual `setTimeout`/`setInterval` needed — croner handles DST transitions and drift prevention.

---

## Heartbeat

### Purpose
Periodic turns in an **existing** agent session. The agent reads an optional `HEARTBEAT.md` checklist and performs proactive checks (inbox, alerts, calendar, etc.).

### Config (`tgcc.yaml`)
```yaml
agents:
  main:
    heartbeat:
      intervalMins: 30          # 5 | 10 | 15 | 30 | 60
      prompt: |
        Heartbeat. Check HEARTBEAT.md and run your scheduled checks.
        Reply HEARTBEAT_OK if nothing to report, or describe any alerts.
      # Optional: only fire if agent is idle (default: true)
      onlyWhenIdle: true
```

### Behaviour
1. At each boundary, check if the agent's CC process exists and is **idle** (if `onlyWhenIdle: true`).
2. If idle (or `onlyWhenIdle: false`): call `sendToCC(agentId, { text: prompt })`.
3. If not idle and `onlyWhenIdle: true`: skip this tick (don't queue, don't defer).
4. The resulting turn is a normal CC turn — events stream to TG, supervisor sees worker events.

### No persistence needed
Heartbeats are config-driven. On restart the bridge re-reads config and re-arms timers at the next boundary.

---

## Cron Jobs

### Purpose
Scheduled jobs with precise timing, independent of any running agent session.

### Job definition
```yaml
# tgcc.yaml — static jobs always loaded at startup
cron:
  jobs:
    - id: morning-briefing
      name: "Morning briefing"
      schedule: "0 8 * * *"      # standard cron expression
      tz: "Europe/Madrid"
      agentId: main
      message: |
        Morning briefing time. Run daily comms check.
      session: isolated           # "main" | "isolated"
      announce: true             # post a TG status message when job fires
      # Optional overrides for isolated sessions:
      model: claude-opus-4-6
      timeoutMs: 120000

    - id: evening-digest
      name: "Evening digest"
      schedule: "0 19 * * *"
      tz: "Europe/Madrid"
      agentId: main
      message: "Evening digest. Summarise today and prepare tomorrow's agenda."
      session: main
```

### Dynamic jobs (`~/.config/tgcc/cron-jobs.json`)
Jobs added at runtime (via slash command) persist in a JSON file, loaded alongside static config jobs. Same schema as above plus:
```json
{
  "createdAt": "2026-03-11T13:00:00Z",
  "runCount": 0,
  "lastRunAt": null,
  "deleteAfterRun": false       // one-shot
}
```

### Session modes

| Mode | Behaviour |
|------|-----------|
| `main` | `sendToCC(agentId, { text: message })` — injects into the existing session, respects `waitForIdle` semantics (skip if busy) |
| `isolated` | Spawns an ephemeral agent (existing mechanism) with `timeoutMs`, runs the message, destroys on completion |

### Slash commands (TG)
```
/cron list                  — show all jobs (static + dynamic) with next-run time
/cron add --every 4h --message "check infra" --session isolated
/cron add --at "20m" --message "follow up with linds" --session main
/cron add --cron "0 9 * * 1-5" --tz Europe/Madrid --message "standup"
/cron run <id>              — trigger immediately
/cron remove <id>
```

One-shots (`--at "20m"` = 20 minutes from now, `--at "2026-03-12T09:00"` = absolute datetime) auto-delete after firing.

---

## Library

Use **`croner`** (already a popular zero-dependency cron library for Node.js). It supports:
- Standard cron expressions
- Timezone-aware scheduling
- TypeScript types

```ts
import { Cron } from 'croner';
```

Heartbeats also use `croner` with the translated cron expression from `intervalMins`.

---

## Implementation Order

1. **Heartbeat** (small, self-contained)
   - `Bridge` gets a `startHeartbeat(agentId, config)` + `stopHeartbeat(agentId)` method
   - Called from `startAgent` / `handleConfigChange`
   - Uses `croner` (same as cron jobs — one scheduling primitive for everything)

2. **Static cron jobs from config** (no CLI, no persistence)
   - Parse `cron.jobs` from `TgccConfig`
   - Use `croner` for scheduling
   - Main session → `sendToCC`, Isolated → ephemeral agent spawn

3. **Dynamic cron jobs + /cron commands**
   - Persist to `~/.config/tgcc/cron-jobs.json`
   - Slash command parser for `/cron add/list/run/remove`
   - One-shot support with `deleteAfterRun`

---

## Key constraints

- **No drift**: Always recalculate next boundary after each fire (don't trust `setInterval` alone for heartbeats)
- **No double-fire**: On config reload, stop old timers before starting new ones (keyed by agentId)
- **No interrupt**: `onlyWhenIdle` protects mid-turn sessions from heartbeat injection
- **Supervisor visibility**: Heartbeat turns produce normal worker events, supervisor sees `✅ Turn complete` as usual
