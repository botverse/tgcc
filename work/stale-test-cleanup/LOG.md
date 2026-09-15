# stale-test-cleanup — log

## 2026-09-15

Baseline confirmed: `npm run build && npx vitest run` → 56 failed / 225 passed / 1 skipped across 7 files, matching the lead's triage exactly. Without a prior `npm run build`, `tests/cli-agent.test.ts` also fails (7 failures, `MODULE_NOT_FOUND dist/cli.js`) — that test spawns the built CLI as a subprocess; this is an environment precondition (repo has no `dist/` checked in, needs a build step before tests that shell out to it), not a stale test. Confirmed not in scope for this task since it's not part of the triaged 56 and passes once built. Treating "npm test" as "npm run build && npx vitest run" for all further baselines in this task.

Branch: `test/stale-test-cleanup`, based on `main@daa004b`.

Lead confirmed the cli-agent.test.ts finding and asked me to (a) document the build-dependency trap and propose a `pretest`/build-first fix in the PR (not applied unilaterally), and (b) refresh against `main` at PR-prep time since another agent is bootstrapping root BACKLOG.md/PROJECT_LOG.md in parallel — propose edits to those instead of creating competing root files if they land first. Both noted here for PR prep.

### config.test.ts (3 failed → 0) — fixed

- `applies defaults for missing agent defaults`: expected model `claude-sonnet-4-20250514`, actual default is `'opus'` (commit `9eaec94`). Also asserted `defaults.maxTurns === 50`; `AgentDefaults` no longer has a `maxTurns` field at all (commit `3bfc0ae` — confirmed by reading the current `AgentDefaults` interface, no replacement field). Updated expected model, dropped the maxTurns assertion.
- `detects added agents` / `allows agents without repo (generic agents)`: both fixtures configure 2 agents with no top-level `supervisor` field; `f36bcc1` made that a hard error for multi-agent configs (single-agent configs still infer the supervisor implicitly). Added `supervisor: '<firstAgentId>'` to both fixtures.
- Verified against current `src/config.ts` directly (DEFAULT_AGENT_DEFAULTS, AgentDefaults interface, validateConfig's supervisor-resolution branch), not just by pattern-matching the error text.

### permissions.test.ts (3 failed → 0) — fixed

- All 3 called `store.setPermissionMode(agentId, userId, mode)`. Confirmed via `git log -S` that `f82380e` ("keep useful info-level logging for debugging") collapsed `SessionStore` from per-user to per-agent state — `setPermissionMode` is now `(agentId, mode)`, and `getUser(agentId, _userId?)` is a documented `@deprecated` alias for `getAgent()` that ignores its second arg. Dropped the userId arg from the 3 calls.

### library-api.test.ts (2 failed → 0) — fixed

- StreamAccumulator custom-sender test: `requestRender()` schedules the throttled flush via `setTimeout`, which never fires before the test's synchronous assertions run (no timer advance, no queue drain). Added `await acc.finalize()` after the simulated turn — matches how `bridge.ts` ends a real turn.
- SubAgentTracker custom-sender test: used the retired fuzzy tool name `'dispatch_agent'`, which no longer matches `isSubAgentTool()`'s exact allowlist (`Agent`, `Task`, `SendMessage`, `TeamCreate` — commit `1d6e47c`). Also asserted an immediate send from `handleEvent()`, but `onBlockStart` only tracks metadata during a turn now — the standalone status bubble is created solely by `startPostTurnTracking()`. Switched the tool name to `'Task'`, added the input-delta + stop events needed to reach `dispatched` status, and asserted on `sends` before/after calling `startPostTurnTracking()`.

### streaming.test.ts (9 failed → 0) — fixed

- 7 of 9 were the mechanical `acc.flush is not a function` (the test-only `flush()` helper was deleted in `dfed4cc`). It is **not** a 1:1 rename to `flushIfDirty()`: that method deliberately (a) drops any still-`pending` tool segments before rendering (so an interrupted turn doesn't ship a frozen "⚡ ..." card) and (b) force-finalizes open-but-empty thinking segments as "done" — both correct for its documented purpose ("call this before reset() when interrupting a mid-turn stream") but wrong for a generic "wait for the pending render" test helper. Used `flushIfDirty()` where that's harmless (plain text-delta tests), and where it wasn't:
  - **'sends thinking indicator' / 'accumulates thinking content'**: the initial `💭` thinking placeholder ships eagerly via a direct `sendQueue` chain (bypassing the throttled-flush path entirely), so the fix is to await `(acc as any).sendQueue` — the same pattern already used in `tests/sub-agent.test.ts` for the identical reason. Independently found (not in the original triage) that both tests also asserted stale text: `'💭 Processing…'` inside a `<blockquote>` — that UI was replaced by a bare `💭` emoji with no blockquote wrapper in commit `679862b` ("bare 💭 placeholder + finalize on steer"); grepped `src/streaming.ts` for `"Processing"` to confirm the string no longer exists anywhere in source. Updated both assertions to expect the bare `'💭'`.
  - **'shows tool use indicator'**: relied on `vi.useFakeTimers()` + `vi.runAllTimersAsync()` to advance past a "500ms tool hide debounce". That timer was deleted in commit `6171e13` ("event-driven tool render gate, drop toolHideTimer") — pending tool cards now render as nothing until they have an extracted `inputPreview` or resolve/error, no timer involved at all (confirmed via `toolEmoji()`: it returns only an emoji, never the tool name as text, so the literal string `'Bash'` can only ever appear via `inputPreview`, which needs an `input_json_delta`). Rewrote the test to send a real `input_json_delta` (`{"command":"ls -la"}`) and used `finalize()` instead of `flushIfDirty()` (whose pending-tool-drop behavior would otherwise filter this segment out before it ever rendered, since the tool call is never resolved in this test).
- This file is the clearest example of why "verify, don't pattern-match" mattered: the triage only flagged the `flush()` rename, but 3 of the 9 failing tests also encoded UI text/timing behavior that had independently drifted from src.

### Running total after streaming.test.ts

`npx vitest run` (post-build): 39 failed / 242 passed / 1 skipped, across 3 files remaining (integration.test.ts, staleness.test.ts, sub-agent.test.ts). Each fix so far was verified against the full suite (not just the touched file) before committing, and each commit's failure count matches the expected reduction with no new failures introduced elsewhere.
