# agent-conversation-monitor — feature backlog

Work ID: `agent-conversation-monitor` · Branch: `feat/agent-conversation-monitor` · Owner: implementing agent (worktree `agent-a255419cfffec4ced`)

See `PLAN.md` in this directory for the full spec (problem, decisions, design, 13 acceptance criteria as of the 2026-09-17 revision).

## Done (implementation complete, self-verified — see LOG.md)

- [x] `ConversationMonitor` module (`src/monitor.ts`): redaction, destructive-pattern flagging, turn-origin tracking, owner exclusion, tagging, forum-topic persistence.
- [x] Outbound delivery pipeline (`src/monitor.ts`): single pump loop per destination chat, packing, critical-vs-routine priority, capped/collapsing routine backlog, topic ids keyed by destination chat id, "warn once" topics-unavailable fallback, destination-change notification. Replaced the original per-agent send-chain design after the lead's review — see LOG.md's 2026-09-17 (later) entry.
- [x] Pattern modules (`src/monitor-redact.ts`, `src/monitor-destructive.ts`).
- [x] `src/telegram.ts`: `sendText(..., threadId)`, `createForumTopic()`, `chatTitle` capture on every inbound message type, `isSupervisorBot` flag gating `/monitor_here` registration + menu visibility.
- [x] `src/config.ts`: `monitor` config block (including required `ownerUserId`) + validation + hot-reload diff detection.
- [x] `src/bridge.ts` wiring: `queueForChat` (Telegram inbound), `sendToCC` (generic non-Telegram capture), `sendSupervisorMessage` (tgcc_send + tgcc_spawn initial message, with traced origin human), new `sendCronMessage` helper (all 8 cron-firing call sites), `proc.on('assistant'|'tool_result'|'result')` in `spawnCCProcess` (covers host + container agents identically — same `ICCProcess` event shapes), `/monitor_here` command with `checkMonitorHereAuth` (pure, exported) authorization, `isMonitorDestinationChat` guard in both `handleTelegramMessage` and `handleSlashCommand`.
- [x] Switched worktree tooling from `npm` to `pnpm` (this repo's actual package manager) per the lead's instruction; deleted the stray untracked `package-lock.json`.

## Open (deferred, not required by the acceptance criteria)

- [ ] Precise `🐕 ralph` tagging for ralph-originated nudges. Investigated: ralph's `sendToCC` calls (via `WatcherManager`) always target the *watcher* agent itself (ralph), not the monitored target it's watching — ralph agents aren't in `monitor.agents` in the plan's example config, so this path is correctly out of scope for now. If a future need arises to mirror ralph's nudges *to a monitored target*, wire a specific `{kind:'ralph'}` capture the same way `sendCronMessage`/`sendSupervisorMessage` do.
- [ ] `tgcc_session(action="new", prompt=...)` and a few other rare supervisor-initiated sends (exec approval flows, IDE-awareness prefixes) fall into the generic 🧭 supervisor bucket rather than a more specific tag. Matches the plan's own tag table (🧭 supervisor is itself a listed category, not just a fallback), so left as-is.
- [ ] Full routing-level proof that non-supervisor `TelegramBot` instances really never wire up `/monitor_here` (i.e. a live grammy `Bot` constructed with `isSupervisorBot: false` and a `/monitor_here` message sent to it produces no command dispatch at all) — my self-verification exercised `checkMonitorHereAuth` as a pure function directly, not through a real `TelegramBot`. Good fit for the tester's suite, which can construct one.
- [ ] The regression suite for the (now 13) acceptance criteria — tester's task, not started here (no tests/ writes by me). My own scratch harnesses (not shipped) are described in LOG.md for the tester's reference.

## Notes

- No tester was on the roster when I started; told the lead once per instructions and proceeded with my own verification (build/typecheck + a scratch harness under a gitignored path, never committed).
- Never write into `tests/`.
