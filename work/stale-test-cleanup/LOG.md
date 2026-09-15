# stale-test-cleanup — log

## 2026-09-15

Baseline confirmed: `npm run build && npx vitest run` → 56 failed / 225 passed / 1 skipped across 7 files, matching the lead's triage exactly. Without a prior `npm run build`, `tests/cli-agent.test.ts` also fails (7 failures, `MODULE_NOT_FOUND dist/cli.js`) — that test spawns the built CLI as a subprocess; this is an environment precondition (repo has no `dist/` checked in, needs a build step before tests that shell out to it), not a stale test. Confirmed not in scope for this task since it's not part of the triaged 56 and passes once built. Treating "npm test" as "npm run build && npx vitest run" for all further baselines in this task.

Branch: `test/stale-test-cleanup`, based on `main@daa004b`.
