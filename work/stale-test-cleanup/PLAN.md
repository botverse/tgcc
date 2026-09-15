# stale-test-cleanup

## Problem

`npm test` (vitest) has a long-standing red baseline of 56 failed / 225 passed / 1 skipped across 7 files (confirmed after `npm run build`; without a build, `tests/cli-agent.test.ts` also fails because it spawns `dist/cli.js` — that's an environment precondition, not a stale-test issue). A previous manual triage git-blamed every failing cluster to a specific commit and concluded all 56 are stale tests (category A: tests that encode behaviour intentionally removed/changed), zero real bugs.

## Scope

- Own `tests/` only. No edits to `src/`.
- Verify the prior triage file-by-file against actual `src/` behavior and git history, not by pattern-matching error text.
- Fix tests that can be aligned to current documented behavior (rename calls, add missing fixture fields, adjust lifecycle calls).
- Delete tests that assert behaviour intentionally and verifiably retired, with justification tied to a commit SHA in LOG.md.
- Do not touch `tests/session-ownership.test.ts`, `tests/session-discovery.test.ts`, `tests/auto-resume.test.ts` (current and green).
- If a failure looks like a real regression (behavior that should still hold), stop, do not delete/fix-to-match, report to the lead instead.

## Acceptance criteria

- `npm test` (after `npm run build`) is fully green, or every remaining failure is explicitly explained and reported as a real bug (not silently left red).
- Every deletion is justified in LOG.md: which commit retired the behaviour, why no replacement assertion is possible.
- Full affected suite run (not just new/changed tests) after each file's changes, to catch collateral breakage.
- Branch pushed, PR opened against `main` (not merged) with verification evidence and deletion rationale.

## Design/spec links

None found in repo (no BACKLOG.md/PROJECT_LOG.md at root at time of writing — tgcc-ops bootstrapping those in a parallel PR). This PLAN.md plus work/stale-test-cleanup/LOG.md and BACKLOG.md are the task's own records per ~/.claude/WORKFLOW.md.

## Dependencies

- tgcc-ops is concurrently bootstrapping root BACKLOG.md/PROJECT_LOG.md in the primary checkout, unrelated branch. Not a blocking dependency for this work; coordinate only at PR-prep time to avoid competing root-record edits.

## Decisions

- Treat "npm test" for baseline/verification purposes as "npm run build && npx vitest run" — cli-agent.test.ts depends on a built dist/cli.js and that's a pre-existing repo characteristic, not something to fix in tests/.
- Integration owner: main (per SendMessage coordination) — this PR proposes root-record entries but does not write them into the primary checkout.

## Owner

tests-agent (this worktree), reporting to `main`.

## Verification plan

Per file: run `npx vitest run tests/<file>.test.ts` after edits, then run the full `npm test` before considering the file done, to catch cross-file collateral effects (shared fixtures, mocks). Final verification: full clean `npm run build && npm test` run recorded in LOG.md before opening the PR.
