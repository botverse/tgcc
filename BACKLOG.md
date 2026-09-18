# Backlog

Bootstrapped 2026-09-15 alongside the first PR to use `~/.claude/WORKFLOW.md` in this repo. This file did not exist before; it starts minimal and grows as real work is planned — it is not a reconstruction of past work.

## Open

- **test-home-sandbox** _(proposal — awaiting review/merge on this PR)_ — fixes a real risk where every `pnpm test`/`npm test` run rewrote the live `~/.tgcc/config.json` (all real bot tokens) via `tests/repo-management.test.ts`'s unsandboxed `CONFIG_PATH` access, in place since `fe3d389` (Feb 2026). Implemented and verified: real config mtime unchanged across full runs on two branches (the originating feature branch and this fix's own `main`-based branch), mutation-checked without ever putting the real file at risk. Branch `fix/test-home-sandbox`, PR open against `main`. Plan: `work/test-home-sandbox/PLAN.md`. Log: `work/test-home-sandbox/LOG.md`.

## Recently completed

- **stale-test-cleanup** — cleared `npm test`'s long-standing red baseline (was 56 failed / 225 passed / 1 skipped). All 56 verified against current `src/` and git history rather than pattern-matched: 23 deleted for intentionally retired behaviour (retiring commit cited per test in the log), 33 fixed in place, zero real bugs found. Also fixed the build-dependency trap in `tests/cli-agent.test.ts` by making `test` run `npm run build` first (`cad851a`). Merged in [PR #4](https://github.com/botverse/tgcc/pull/4) as `d3a73ca`; suite green on `main` at that commit. Plan: `work/stale-test-cleanup/PLAN.md`. Log: `work/stale-test-cleanup/LOG.md`.
- **systemd-unit-tracking** — track the TGCC systemd user unit in-repo (`systemd/tgcc.service`) and symlink the live unit to it, so the fix that ended today's day-long crash loop survives host loss. Plan: `work/systemd-unit-tracking/PLAN.md`. Log: `work/systemd-unit-tracking/LOG.md`.
