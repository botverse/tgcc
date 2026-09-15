# Backlog

Bootstrapped 2026-09-15 alongside the first PR to use `~/.claude/WORKFLOW.md` in this repo. This file did not exist before; it starts minimal and grows as real work is planned — it is not a reconstruction of past work.

## Open

- **stale-test-cleanup** — `npm test` had a long-standing red baseline (56 failed / 225 passed / 1 skipped). Verified all 56 against current `src/` and git history (not pattern-matched) and cleared them: 23 deleted (tests for behavior intentionally retired, with no replacement assertion possible — root cause commit cited per test in the log) and 33 fixed in place to match current interfaces/UI text. Zero real bugs found. Branch-verified green: `npm run build && npm test` → 0 failed / 259 passed / 1 skipped. Owner: tests-agent. Plan: `work/stale-test-cleanup/PLAN.md`. Log: `work/stale-test-cleanup/LOG.md` (includes a proposed `pretest` script fix for a build-dependency trap in `tests/cli-agent.test.ts`, not yet actioned — pending integration-owner review). PR: https://github.com/botverse/tgcc/pull/4 (not merged).

## Recently completed

- **systemd-unit-tracking** — track the TGCC systemd user unit in-repo (`systemd/tgcc.service`) and symlink the live unit to it, so the fix that ended today's day-long crash loop survives host loss. Plan: `work/systemd-unit-tracking/PLAN.md`. Log: `work/systemd-unit-tracking/LOG.md`.
