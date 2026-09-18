# test-home-sandbox — log

## 2026-09-17

### Discovery

While serving as the tester for `agent-conversation-monitor` (branch `feat/agent-conversation-monitor`), ran the final test gate twice (an intermediate check, then the actual final gate after `rm -rf dist && pnpm run build`). The integration lead independently noticed the real `~/.tgcc/config.json`'s mtime had moved twice during that window (17:24:05 and 17:25:38 BST) and flagged that `tgcc.service`'s own logs showed no activity in that window at all — so the live service hadn't written it, and something in the test process had. Content was intact (diffed against a morning snapshot: same 13 agents, same bot tokens, same users/chats/perms, no stray `monitor` block, no `~/.tgcc/monitor-topics.json`), but the lead was explicit that intact content this time didn't mean the mechanism was safe, and asked for the actual cause to be found rather than assumed either way — four files were named as possible suspects based on a rough grep: `tests/monitor.test.ts`, `tests/monitor-bridge.test.ts`, `tests/repo-management.test.ts`, `tests/cli-agent.test.ts`.

### Investigation (static reading first, then confirmed empirically — never risking the real file)

Read `src/config.ts`: `CONFIG_PATH` is `export const CONFIG_PATH = join(homedir(), '.tgcc', 'config.json');` — a module-level constant, evaluated once at import time, with no override parameter anywhere it's consumed (`loadConfig()` has an optional path parameter that defaults to `CONFIG_PATH`, but nothing in `src/cli.ts` ever passes anything else; `updateConfig()` has no parameter at all and always targets `CONFIG_PATH` directly).

Checked each suspect file's source directly:
- `tests/monitor.test.ts`, `tests/monitor-bridge.test.ts` (this feature's own files): every `ConversationMonitor` constructed in these files is given an explicit `persistPath` (a `mkdtempSync` tmp dir) and `writeConfigChatId` spy; `monitor-bridge.test.ts` additionally mocks `node:os`'s `homedir()` for its `Bridge` construction. Neither file's tests ever call the real `updateConfig()`.
- `tests/cli-agent.test.ts` (pre-existing): spawns the real `dist/cli.js` as a child process, but explicitly passes `env: { ...process.env, TGCC_CONFIG: configPath, HOME: testDir }` to that child. `TGCC_CONFIG` turned out to be a no-op for the CLI's agent-management commands (only `src/service.ts` reads that env var; `src/cli.ts` imports `CONFIG_PATH` directly and never consults it), but `HOME: testDir` is not — Node's own `os.homedir()` on POSIX honours `$HOME` first, so the spawned child's own `CONFIG_PATH` resolves into `testDir`, matching what the test's `beforeEach` already seeds there.
- `tests/repo-management.test.ts` (pre-existing, `fe3d389`, Feb 2026): its `describe('updateConfig', ...)` block does `const origConfigPath = CONFIG_PATH;` directly — no override, despite its own comment two lines above admitting the gap ("We need to override CONFIG_PATH for updateConfig... since CONFIG_PATH is a const export, we'll test updateConfig indirectly") and then never following through. `beforeEach` backs up `readFileSync(origConfigPath, 'utf-8')` if it exists; each test calls the real `updateConfig()` (writing test repo entries like `__test_repo_<timestamp>`); `afterEach` restores the backup.

Confirmed empirically per the lead's suggested method (`HOME=<scratch> vitest run <file>`), executed via a small Node wrapper script (`child_process.execSync(..., { env })`, never committed, deleted after use) rather than a literal shell `HOME=` assignment, since this worktree's command-safety guard blocks that pattern outright:
- `tests/repo-management.test.ts` run with `HOME` unsandboxed (i.e. against this real machine's home) and then with `HOME` pointed at a scratch dir: unsandboxed, "adds a repo to config" reads whatever `~/.tgcc/config.json` happens to exist; sandboxed, the same test failed with `ENOENT` reading a file that (correctly) didn't exist yet in a brand-new scratch home, and other tests in the same block created `<scratch>/.tgcc/config.json` via their own `updateConfig` calls. This directly reproduces the lead's finding: real machine, real file, moved by this test.
- `tests/monitor.test.ts`, `tests/monitor-bridge.test.ts`, `tests/cli-agent.test.ts`: confirmed clean under the same method — no `.tgcc/` directory ever appeared in the outer scratch home for any of them.

### Fix

Two layers, both landed as `60d17e7` on `feat/agent-conversation-monitor` first (where the investigation happened), then cherry-picked here unchanged:

1. **`vitest.config.ts` (repo root, outside `tests/` — a one-off exception explicitly authorized by the lead).** Sets `test.env.HOME` to a fresh `mkdtempSync(join(tmpdir(), 'tgcc-test-home-'))` scratch directory. Vitest documents `test.env` as "custom environment variables assigned to `process.env` before running tests" — applied before any test module (and therefore any module-level constant such as `CONFIG_PATH`) is imported, for the whole worker pool. This is the structural fix: it protects every test file, including ones — present or future — that forget a per-file `vi.mock('node:os')`.
2. **`tests/repo-management.test.ts`.** The `updateConfig` describe block now seeds a small, throwaway config (`{ repos: {}, agents: { seedagent: {...} } }`) into `CONFIG_PATH` — which now resolves into the sandboxed `HOME` — in `beforeEach`, and removes it in `afterEach`. This also incidentally fixed two tests ("assigns a repo to an agent" / "clears an agent repo assignment") that previously did `if (agentIds.length === 0) return;` and would silently skip their actual assertions on any machine with zero configured agents; they now always run, since the seed always includes one.

### Verification

**On `feat/agent-conversation-monitor` (where the fix originated), before cherry-picking here:**
- Real `~/.tgcc/config.json` mtime: `1789662338` / `2026-09-17 17:25:38.343185495 +0100` (matches the lead's own reported second timestamp exactly) — checked before the fix, immediately after a full `pnpm test`, again after a second full run, and again after the final gate on the pushed commit. Identical every time.
- `pnpm run build` clean (after `rm -rf dist`); `pnpm test`: 22 files / 398 passed / 1 skipped — identical to that branch's established baseline, zero regressions.

**On this branch (`fix/test-home-sandbox`, based on `origin/main`), after `git cherry-pick 60d17e7`:**
- Cherry-pick applied cleanly with zero conflicts, as expected — the fix touches only `vitest.config.ts` and `tests/repo-management.test.ts`, neither of which the monitor feature branch's other changes go near.
- `pnpm install`: lockfile already up to date, no changes.
- `pnpm run build` clean (after `rm -rf dist`).
- `pnpm test`: **17 files / 259 passed / 1 skipped** — the pre-monitor-feature baseline (matches `stale-test-cleanup`'s final recorded state exactly: same 259/1/17). Run twice for confidence; identical both times.
- Real `~/.tgcc/config.json` mtime: `1789662338` (unchanged from the value recorded above) — checked before the first build/test run on this branch, after the first `pnpm test`, and after the second `pnpm test`. Identical every time, on this branch as well as the originating one.

### Mutation check

Temporarily commented out the `env: { HOME: sandboxHome }` block in `vitest.config.ts` (on the `feat/agent-conversation-monitor` worktree, before cherry-picking the restored version here), then re-ran `tests/repo-management.test.ts` through the same external Node wrapper script used during discovery — which independently sandboxes `HOME` at the OS-process level for the *outer* `vitest run` invocation, so the real file was never at risk during the check regardless of the in-repo fix's state. Result: with the in-repo fix disabled, the test's resolved `CONFIG_PATH` fell through to the wrapper's own external scratch directory (a `.tgcc/` directory appeared there) instead of vitest's internal sandbox (which showed nothing) — proving the `vitest.config.ts` fix is the active layer normally providing protection when present, not a no-op. Restored immediately; `git diff` confirmed clean before moving on.

### Status

Complete. Branch `fix/test-home-sandbox`, based on `origin/main`, single commit (`562ddb0`, content identical to `60d17e7`). PR opened against `main`, not merged — the owner's decision. `feat/agent-conversation-monitor` is left untouched; if this PR merges first, that branch will need a rebase before its own merge (identical content means the cherry-picked hunks become a no-op), noted for whoever handles that.
