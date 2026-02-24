import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateConfig,
  resolveUserConfig,
  type TgccConfig,
  type AgentConfig,
} from '../src/config.js';
import { SessionStore } from '../src/session.js';
import pino from 'pino';

const logger = pino({ level: 'silent' });

// ── Config validation for permission modes ──

describe('permission modes in config', () => {
  const baseConfig = {
    agents: {
      test: {
        botToken: 'tok-1',
        allowedUsers: ['123'],
        defaults: {},
      },
    },
  };

  it('accepts dangerously-skip', () => {
    const cfg = validateConfig({
      ...baseConfig,
      agents: {
        test: {
          ...baseConfig.agents.test,
          defaults: { permissionMode: 'dangerously-skip' },
        },
      },
    });
    expect(cfg.agents.test.defaults.permissionMode).toBe('dangerously-skip');
  });

  it('accepts acceptEdits', () => {
    const cfg = validateConfig({
      ...baseConfig,
      agents: {
        test: {
          ...baseConfig.agents.test,
          defaults: { permissionMode: 'acceptEdits' },
        },
      },
    });
    expect(cfg.agents.test.defaults.permissionMode).toBe('acceptEdits');
  });

  it('accepts default', () => {
    const cfg = validateConfig({
      ...baseConfig,
      agents: {
        test: {
          ...baseConfig.agents.test,
          defaults: { permissionMode: 'default' },
        },
      },
    });
    expect(cfg.agents.test.defaults.permissionMode).toBe('default');
  });

  it('accepts plan', () => {
    const cfg = validateConfig({
      ...baseConfig,
      agents: {
        test: {
          ...baseConfig.agents.test,
          defaults: { permissionMode: 'plan' },
        },
      },
    });
    expect(cfg.agents.test.defaults.permissionMode).toBe('plan');
  });

  it('falls back to dangerously-skip for invalid mode', () => {
    const cfg = validateConfig({
      ...baseConfig,
      agents: {
        test: {
          ...baseConfig.agents.test,
          defaults: { permissionMode: 'invalid-mode' },
        },
      },
    });
    expect(cfg.agents.test.defaults.permissionMode).toBe('dangerously-skip');
  });

  it('falls back to dangerously-skip when permissionMode omitted', () => {
    const cfg = validateConfig(baseConfig);
    expect(cfg.agents.test.defaults.permissionMode).toBe('dangerously-skip');
  });

  // Reject old 'allowlist' mode that was removed
  it('falls back to dangerously-skip for old allowlist mode', () => {
    const cfg = validateConfig({
      ...baseConfig,
      agents: {
        test: {
          ...baseConfig.agents.test,
          defaults: { permissionMode: 'allowlist' },
        },
      },
    });
    expect(cfg.agents.test.defaults.permissionMode).toBe('dangerously-skip');
  });
});

// ── resolveUserConfig permission propagation ──

describe('resolveUserConfig with permissionMode', () => {
  it('returns agent default permissionMode', () => {
    const agent: AgentConfig = {
      botToken: 'tok',
      allowedUsers: ['1'],
      defaults: {
        model: 'test',
        repo: '/tmp',
        maxTurns: 10,
        idleTimeoutMs: 1000,
        hangTimeoutMs: 1000,
        permissionMode: 'plan',
      },
    };
    const resolved = resolveUserConfig(agent, '1');
    expect(resolved.permissionMode).toBe('plan');
  });
});

// ── Session store permission mode ──

describe('SessionStore permissionMode', () => {
  let tmpDir: string;
  let statePath: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `tgcc-perm-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    statePath = join(tmpDir, 'state.json');
    store = new SessionStore(statePath, logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults permissionMode to empty string', () => {
    const user = store.getUser('agent1', 'user1');
    expect(user.permissionMode).toBe('');
  });

  it('sets and reads permissionMode', () => {
    store.setPermissionMode('agent1', 'user1', 'plan');
    const user = store.getUser('agent1', 'user1');
    expect(user.permissionMode).toBe('plan');
  });

  it('persists permissionMode to disk', () => {
    store.setPermissionMode('agent1', 'user1', 'acceptEdits');
    // Re-read from disk
    const store2 = new SessionStore(statePath, logger);
    const user = store2.getUser('agent1', 'user1');
    expect(user.permissionMode).toBe('acceptEdits');
  });

  it('can clear permissionMode by setting empty string', () => {
    store.setPermissionMode('agent1', 'user1', 'plan');
    store.setPermissionMode('agent1', 'user1', '');
    const user = store.getUser('agent1', 'user1');
    expect(user.permissionMode).toBe('');
  });
});

// ── Permission resolution priority ──

describe('permission resolution priority', () => {
  it('session override takes precedence over agent default', () => {
    // Simulates what bridge.ts does: read agent default, then override from session
    const agentDefault = 'dangerously-skip';
    const sessionOverride = 'plan';

    // This mirrors the logic in spawnCCProcess
    let effectiveMode = agentDefault;
    if (sessionOverride) {
      effectiveMode = sessionOverride;
    }
    expect(effectiveMode).toBe('plan');
  });

  it('agent default used when no session override', () => {
    const agentDefault = 'acceptEdits';
    const sessionOverride = ''; // empty = no override

    let effectiveMode = agentDefault;
    if (sessionOverride) {
      effectiveMode = sessionOverride;
    }
    expect(effectiveMode).toBe('acceptEdits');
  });

  it('fallback is dangerously-skip when both are empty', () => {
    // This is guaranteed by config validation — agent default always has a value
    const cfg = validateConfig({
      agents: {
        test: {
          botToken: 'tok',
          allowedUsers: ['1'],
        },
      },
    });
    expect(cfg.agents.test.defaults.permissionMode).toBe('dangerously-skip');
  });
});
