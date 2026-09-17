# agent-conversation-monitor — feature backlog

Work ID: `agent-conversation-monitor` · Branch: `feat/agent-conversation-monitor` · Owner: implementing agent (worktree `agent-a255419cfffec4ced`)

See `PLAN.md` in this directory for the full spec (problem, decisions, design, 11 acceptance criteria).

## Done (implementation complete, self-verified — see LOG.md)

- [x] `ConversationMonitor` module (`src/monitor.ts`): redaction, destructive-pattern flagging, turn-origin tracking, owner exclusion, coalescing, tagging, ordered/429-safe delivery, forum-topic persistence.
- [x] Pattern modules (`src/monitor-redact.ts`, `src/monitor-destructive.ts`).
- [x] `src/telegram.ts`: `sendText(..., threadId)`, `createForumTopic()`, `chatTitle` capture on every inbound message type.
- [x] `src/config.ts`: `monitor` config block + validation + hot-reload diff detection.
- [x] `src/bridge.ts` wiring: `queueForChat` (Telegram inbound), `sendToCC` (generic non-Telegram capture), `sendSupervisorMessage` (tgcc_send + tgcc_spawn initial message, with traced origin human), new `sendCronMessage` helper (all 8 cron-firing call sites), `proc.on('assistant'|'tool_result'|'result')` in `spawnCCProcess` (covers host + container agents identically — same `ICCProcess` event shapes), `/monitor_here` command.

## Open (deferred, not required by the 11 acceptance criteria)

- [ ] Precise `🐕 ralph` tagging for ralph-originated nudges. Investigated: ralph's `sendToCC` calls (via `WatcherManager`) always target the *watcher* agent itself (ralph), not the monitored target it's watching — ralph agents aren't in `monitor.agents` in the plan's example config, so this path is correctly out of scope for now. If a future need arises to mirror ralph's nudges *to a monitored target*, wire a specific `{kind:'ralph'}` capture the same way `sendCronMessage`/`sendSupervisorMessage` do.
- [ ] `tgcc_session(action="new", prompt=...)` and a few other rare supervisor-initiated sends (exec approval flows, IDE-awareness prefixes) fall into the generic 🧭 supervisor bucket rather than a more specific tag. Matches the plan's own tag table (🧭 supervisor is itself a listed category, not just a fallback), so left as-is.
- [ ] The regression suite for the 11 acceptance criteria — tester's task, not started here (no tests/ writes by me). My own scratch harness (not shipped) is described in LOG.md for the tester's reference.

## Notes

- No tester was on the roster when I started; told the lead once per instructions and proceeded with my own verification (build/typecheck + a scratch harness under a gitignored path, never committed).
- Never write into `tests/`.
