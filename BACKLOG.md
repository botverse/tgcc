# Backlog

Bootstrapped 2026-09-15 alongside the first PR to use `~/.claude/WORKFLOW.md` in this repo. This file did not exist before; it starts minimal and grows as real work is planned — it is not a reconstruction of past work.

## Open

- **agent-conversation-monitor** — mirrors monitored-agent Telegram conversations (minus owner-originated turns) into a private Telegram destination for oversight, with destructive-action flagging and secret redaction. Implementation complete and self-verified (build clean, full existing `npm test` suite still green with no `monitor` config block, plus an unshipped scratch harness against all 11 acceptance criteria — see `work/agent-conversation-monitor/LOG.md`). **Not yet reviewed, not yet tested by a dedicated regression suite (tests/ not written), and not yet deployed** — a tester still needs to write `tests/` coverage against the 11 criteria in `work/agent-conversation-monitor/PLAN.md` before this is ready to merge; deployment (creating the destination supergroup, restarting `tgcc`, running `/monitor_here`) is a separate authorized step after merge. Plan/backlog/log: `work/agent-conversation-monitor/`. Branch: `feat/agent-conversation-monitor`.

## Recently completed

- **stale-test-cleanup** — cleared `npm test`'s long-standing red baseline (was 56 failed / 225 passed / 1 skipped). All 56 verified against current `src/` and git history rather than pattern-matched: 23 deleted for intentionally retired behaviour (retiring commit cited per test in the log), 33 fixed in place, zero real bugs found. Also fixed the build-dependency trap in `tests/cli-agent.test.ts` by making `test` run `npm run build` first (`cad851a`). Merged in [PR #4](https://github.com/botverse/tgcc/pull/4) as `d3a73ca`; suite green on `main` at that commit. Plan: `work/stale-test-cleanup/PLAN.md`. Log: `work/stale-test-cleanup/LOG.md`.
- **systemd-unit-tracking** — track the TGCC systemd user unit in-repo (`systemd/tgcc.service`) and symlink the live unit to it, so the fix that ended today's day-long crash loop survives host loss. Plan: `work/systemd-unit-tracking/PLAN.md`. Log: `work/systemd-unit-tracking/LOG.md`.
