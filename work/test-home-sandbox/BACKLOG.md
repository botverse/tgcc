# test-home-sandbox — feature backlog

Work ID: `test-home-sandbox` · Branch: `fix/test-home-sandbox` (cherry-picked from `feat/agent-conversation-monitor`'s `60d17e7`) · Owner: monitor-tests, reporting to `main`.

See `PLAN.md` for the full problem/scope, `LOG.md` for findings, investigation, and verification detail.

## Done

- [x] Identified the actual culprit (`tests/repo-management.test.ts`) rather than assuming — ruled out every other suspect file individually.
- [x] Global `HOME` sandbox in `vitest.config.ts` (repo root, one-off exception), applied before any test module loads.
- [x] `tests/repo-management.test.ts` now seeds/cleans its own throwaway config in the sandboxed path, instead of depending on or risking a real one.
- [x] Verified on `feat/agent-conversation-monitor` (where the fix originated, 398-test baseline) and re-verified independently on this `main`-based branch (259-test baseline).
- [x] Mutation-checked without the real file ever being at risk during the check (an external, independent safety net protected it throughout).

## Open

_(none — this is a complete, single-commit fix, ready for review)_
