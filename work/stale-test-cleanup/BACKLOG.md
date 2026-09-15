# stale-test-cleanup — feature backlog

## Tasks

- [ ] config.test.ts (3 failures) — fixture/expectation updates
- [ ] integration.test.ts (10 failures) — delete SessionStore titling/deletion tests, delete/invert takeover-event test
- [ ] library-api.test.ts (2 failures) — add missing lifecycle calls
- [ ] permissions.test.ts (3 failures) — drop userId arg from setPermissionMode calls
- [ ] staleness.test.ts (14 failures) — delete JSONL-delta subsystem tests, keep 1 passing test
- [ ] streaming.test.ts (9 failures) — rename acc.flush() to flushIfDirty()/finalize() per case
- [ ] sub-agent.test.ts (15 failures) — replace fuzzy 'dispatch_agent' names with allowlisted names (Agent/Task/SendMessage/TeamCreate)
- [ ] Full suite green (or every remaining red explained)
- [ ] Push branch, open PR against main, propose work/stale-test-cleanup root-record note (no competing root files since none exist yet)

## Blockers

None currently.
