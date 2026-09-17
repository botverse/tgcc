# agent-conversation-monitor — feature backlog

Work ID: `agent-conversation-monitor` · Branch: `feat/agent-conversation-monitor` · Owner: implementing agent (worktree `agent-a255419cfffec4ced`)

See `PLAN.md` in this directory for the full spec (problem, decisions, design, 11 acceptance criteria).

## Open

- [ ] Implement `ConversationMonitor` module (redaction, destructive-pattern flagging, coalescing, tagging).
- [ ] Wire capture sites in `src/bridge.ts`: `handleTelegramMessage`, `sendToCC`, the CC stream-event path feeding `StreamAccumulator`, `handleMcpToolRequest` → `tgcc_send`, and `src/transcribe.ts` voice transcription.
- [ ] Extend `src/telegram.ts` with `message_thread_id` support and `createForumTopic` if not already present.
- [ ] Config: `monitor` block in `~/.tgcc/config.json` schema (`src/config.ts`), hot-reload support, `/monitor_here` command to record chat id, per-agent topic id persistence.
- [ ] Container agent coverage (`sentinella_team`, `kyo_team` via `ContainerCCProcess`) — confirm their events reach the monitor through the same bridge path as host agents.
- [ ] Failure isolation: wrap all monitor sends so they never throw into the bridge or delay agent replies.
- [ ] Self-verification: `npm run build` clean, scratch harness exercising redaction/flagging/coalescing logic (no tests/ writes — tester owns that).

## Notes

- No tester on roster yet; I own my own verification (build/typecheck/scratch harnesses) until one is assigned.
- Do not write into `tests/`.
