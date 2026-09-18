# test-home-sandbox

## Problem

`src/config.ts` exports `CONFIG_PATH` as a module-level constant (`join(homedir(), '.tgcc', 'config.json')`), computed once, the moment any test file first imports `config.ts` — before any per-test `beforeEach`/`vi.mock` hook gets a chance to run. `tests/repo-management.test.ts` (added in `fe3d389`, Feb 2026, predates the `agent-conversation-monitor` feature by months) reads and writes this real path directly with no redirection at all: its `updateConfig` tests back up whatever `~/.tgcc/config.json` exists on the machine running the tests, mutate it with throwaway repo entries, and restore the backup afterward. Every `pnpm test`/`npm test` run on any developer machine has therefore been reading and overwriting the live config — including all real bot tokens — the entire time this file has existed, safe only as long as the backup/restore pair completes without a crash mid-write or without racing the live `tgcc` systemd service's own writes to the same file. That's the same class of outage as the `systemd-unit-tracking` incident on 2026-09-15 (`PROJECT_LOG.md`), this time on the config file rather than the unit file.

Discovered while verifying an unrelated feature branch (`agent-conversation-monitor`)'s final test gate: the integration lead noticed the real file's mtime moving during that gate's test runs, with no corresponding `tgcc.service` log activity to explain it, and asked for the actual cause to be found rather than assumed.

## Scope

- `vitest.config.ts` (repo root) and `tests/repo-management.test.ts` only. No `src/` changes.
- Sandbox `HOME` for the whole suite before any test module loads, so `CONFIG_PATH` (and any other `homedir()`-based path) can never resolve to a real path regardless of whether an individual test file remembers to mock `node:os` itself.
- Fix `tests/repo-management.test.ts` to seed/clean its own throwaway config in the now-sandboxed path instead of depending on — or risking — a real one.
- Out of scope: auditing every other test file for the same class of gap beyond what this investigation already covered. Every other suspect (`tests/monitor.test.ts`, `tests/monitor-bridge.test.ts`, `tests/cli-agent.test.ts`) was checked and confirmed already hermetic — see `LOG.md`.

## Acceptance criteria

- Real `~/.tgcc/config.json` mtime unchanged across a full `pnpm test` run, verified on both the originating feature branch (`feat/agent-conversation-monitor`) and this `main`-based branch.
- `pnpm run build` clean; full `pnpm test` green on the `main` base (pre-monitor-feature test count, not the 398-test count from the feature branch).
- Mutation-checked: temporarily disabling the fix (with an independent, external safety net protecting the real file throughout the check) demonstrably changes behaviour, proving the fix is the active protective layer and not a no-op.

## Design/spec links

None needed beyond this PLAN.md — a small, self-contained fix. See `PROJECT_LOG.md`'s 2026-09-15 `systemd-unit-tracking` entry for the same class of prior incident.

## Decisions

- Land as its own PR against `main`, separate from `agent-conversation-monitor` (PR #6), per `~/.claude/WORKFLOW.md`: it's an independent safety fix, and the feature branch still has review and a deploy decision ahead of it. `main` has the bug until this merges.
- Fix structurally (a global `vitest.config.ts` sandbox) rather than only patching the one offending file, so a future test file that forgets a per-file `vi.mock('node:os')` is still protected. Per-file overrides (this feature's own `tests/monitor.test.ts` / `tests/monitor-bridge.test.ts`, and the pre-existing `tests/auto-resume.test.ts`) stay in place as defence in depth.
- `vitest.config.ts` sits at the repo root, outside the tester's normal `tests/`-only ownership — an explicit, one-off exception authorized by the integration lead, called out in the commit message and here rather than made silently.

## Owner

monitor-tests (spawned for `agent-conversation-monitor`'s test suite), reporting to `main`. The fix originated on `feat/agent-conversation-monitor` as commit `60d17e7` and is cherry-picked onto this branch unchanged, since the content is fully separable from that feature's own code.

## Verification plan

`rm -rf dist && pnpm run build && pnpm test`, with the real `~/.tgcc/config.json` mtime captured via `stat` immediately before and after, on both the feature branch (398-test baseline) and this `main`-based branch (pre-monitor baseline). Mutation check: temporarily comment out the `env.HOME` block in `vitest.config.ts`, re-run the implicated test file through an external HOME-sandboxing wrapper script (never committed) that independently protects the real path regardless of the in-repo fix's state, confirm the resolved config path changes as a result, then restore and re-verify.
