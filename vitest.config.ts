import { defineConfig } from 'vitest/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// One-off exception to the "tests/ only" ownership boundary (repo root, not under tests/) —
// flagged to the lead as a repo-wide finding rather than filed in a single feature's own
// records, since it affects every test file, not just this one.
//
// src/config.ts computes `CONFIG_PATH` as a MODULE-LEVEL constant
// (`join(homedir(), '.tgcc', 'config.json')`), evaluated once, the moment any test file first
// imports config.ts (directly, or transitively via bridge.ts) — before any per-test
// `beforeEach`/`vi.mock` hook gets a chance to run. A per-test-file `vi.mock('node:os')` (the
// pattern tests/auto-resume.test.ts and this feature's own tests/monitor-bridge.test.ts use)
// only protects the file that remembers to add it; tests/repo-management.test.ts (pre-existing,
// predates this feature, already on main since fe3d389) never did, and its `updateConfig`
// describe block read and wrote whatever CONFIG_PATH resolved to with NO redirection at all —
// confirmed by running it in isolation with HOME sandboxed vs. not. Every real run of
// `pnpm test`/`vitest run` on a developer machine had therefore been reading and overwriting
// that machine's REAL `~/.tgcc/config.json` (all live bot tokens included) the entire time,
// restoring a pre-test backup afterward — safe only as long as nothing crashed mid-write or
// raced the live tgcc service's own writes to the same file.
//
// Setting HOME here makes Node's own (unmocked) `os.homedir()` — used by every test file,
// whether or not it remembers to mock anything — resolve into a fresh, disposable sandbox for
// the whole run, before ANY test module (and therefore any module-level constant) is ever
// imported. Per-file `vi.mock('node:os')` overrides remain in place too as defence in depth;
// this is the outer, structural layer that protects a test file that forgets one.
const sandboxHome = mkdtempSync(join(tmpdir(), 'tgcc-test-home-'));

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    env: {
      HOME: sandboxHome,
    },
  },
});
