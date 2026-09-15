# stale-test-cleanup — feature backlog

## Tasks

- [x] config.test.ts (3 failures) — fixed: fixture/expectation updates (default model, dropped maxTurns, added supervisor field)
- [x] integration.test.ts (10 failures) — 9 deleted (retired SessionStore titling/deletion API), 1 inverted + extended (takeover false-positive guard)
- [x] library-api.test.ts (2 failures) — fixed: added missing lifecycle calls (finalize, startPostTurnTracking)
- [x] permissions.test.ts (3 failures) — fixed: dropped userId arg from setPermissionMode calls
- [x] staleness.test.ts (14 failures) — deleted (retired JSONL-delta subsystem), kept the 1 passing test
- [x] streaming.test.ts (9 failures) — fixed: flush() rename to flushIfDirty()/finalize()/sendQueue depending on case, plus 2 independently-found stale-UI-text issues
- [x] sub-agent.test.ts (15 failures) — fixed: fuzzy tool names replaced with exact allowlist, plus 1 independently-found stale-UI-text issue
- [x] Full suite green (verified clean: `rm -rf dist && npm run build && npx vitest run` → 259 passed / 1 skipped / 0 failed, re-verified after rebasing onto origin/main)
- [x] Rebase onto origin/main (picked up root BACKLOG.md/PROJECT_LOG.md/CLAUDE.md bootstrap + .gitignore `.claude/` entry from the parallel systemd-unit-tracking PRs — clean, no conflicts)
- [x] Push branch, open PR against main (https://github.com/botverse/tgcc/pull/4, not merged), propose root BACKLOG.md/PROJECT_LOG.md edits (root records now exist — bootstrapped by another agent — proposed edits to them rather than creating competing files)

## Notes for PR

- Real bugs found: none. Every failure traced to a specific commit that intentionally changed the behavior under test; verified against current `src/` directly (not just error-text pattern-matching) in every case, including catching 3 additional stale-text issues the original triage hadn't listed (streaming.test.ts ×2, sub-agent.test.ts ×1) by reading the actual render output instead of trusting the flush()-rename framing alone.
- Build-dependency trap found and documented but not fixed (src/tooling change, out of scope for `tests/`): `npm test` needs a prior `npm run build` for cli-agent.test.ts to pass (spawns `dist/cli.js`, no `pretest` hook wired up). Proposing a `pretest` script in the PR description for the integration owner to pick up.

## Blockers

None.
