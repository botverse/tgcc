import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, existsSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateConfig,
  diffConfigs,
  resolveUserConfig,
  resolveRepoPath,
  agentForRepo,
  type TgccConfig,
  type AgentConfig,
} from '../src/config.js';

const VALID_CONFIG = {
  global: {
    ccBinaryPath: 'claude',
    mediaDir: '/tmp/test-media',
    socketDir: '/tmp/test-sockets',
    logLevel: 'info',
    stateFile: '/tmp/test-state.json',
  },
  agents: {
    personal: {
      botToken: 'test-token-1',
      allowedUsers: ['123456'],
      defaults: {
        model: 'claude-opus-4-6',
        repo: '/home/test',
        maxTurns: 50,
        idleTimeoutMs: 300000,
        hangTimeoutMs: 300000,
        permissionMode: 'dangerously-skip',
      },
      users: {
        '123456': {
          model: 'claude-sonnet-4-20250514',
          repo: '/home/test/project',
        },
      },
    },
  },
};

describe('validateConfig', () => {
  it('validates a correct config', () => {
    const config = validateConfig(VALID_CONFIG);
    expect(config.agents.personal).toBeDefined();
    expect(config.agents.personal.botToken).toBe('test-token-1');
  });

  it('applies defaults for missing global fields', () => {
    const config = validateConfig({
      agents: {
        test: {
          botToken: 'tok',
          allowedUsers: ['1'],
        },
      },
    });
    expect(config.global.ccBinaryPath).toBe('claude');
    expect(config.global.logLevel).toBe('info');
  });

  it('applies defaults for missing agent defaults', () => {
    const config = validateConfig({
      agents: {
        test: {
          botToken: 'tok',
          allowedUsers: ['1'],
        },
      },
    });
    expect(config.agents.test.defaults.model).toBe('claude-sonnet-4-20250514');
    expect(config.agents.test.defaults.maxTurns).toBe(50);
    expect(config.agents.test.defaults.permissionMode).toBe('dangerously-skip');
  });

  it('rejects config without agents', () => {
    expect(() => validateConfig({ global: {} })).toThrow('must have an "agents" object');
  });

  it('rejects config with empty agents', () => {
    expect(() => validateConfig({ agents: {} })).toThrow('at least one agent');
  });

  it('rejects agent without botToken', () => {
    expect(() => validateConfig({
      agents: { test: { allowedUsers: ['1'] } },
    })).toThrow('botToken');
  });

  it('rejects agent without allowedUsers', () => {
    expect(() => validateConfig({
      agents: { test: { botToken: 'tok' } },
    })).toThrow('allowedUsers');
  });

  it('accepts agent with empty allowedUsers (open access)', () => {
    expect(() => validateConfig({
      agents: { test: { botToken: 'tok', allowedUsers: [] } },
    })).not.toThrow();
  });

  it('rejects duplicate bot tokens', () => {
    expect(() => validateConfig({
      agents: {
        a: { botToken: 'same', allowedUsers: ['1'] },
        b: { botToken: 'same', allowedUsers: ['2'] },
      },
    })).toThrow('Duplicate botToken');
  });

  it('rejects non-object config', () => {
    expect(() => validateConfig(null)).toThrow();
    expect(() => validateConfig('string')).toThrow();
  });
});

describe('resolveUserConfig', () => {
  it('uses agent defaults when no user override', () => {
    const agent: AgentConfig = {
      botToken: 'tok',
      allowedUsers: ['1'],
      defaults: {
        model: 'claude-opus-4-6',
        repo: '/default',
        maxTurns: 50,
        idleTimeoutMs: 300000,
        hangTimeoutMs: 300000,
        permissionMode: 'dangerously-skip',
      },
    };
    const resolved = resolveUserConfig(agent, '999');
    expect(resolved.model).toBe('claude-opus-4-6');
    expect(resolved.repo).toBe('/default');
  });

  it('applies user overrides', () => {
    const agent: AgentConfig = {
      botToken: 'tok',
      allowedUsers: ['1'],
      defaults: {
        model: 'claude-opus-4-6',
        repo: '/default',
        maxTurns: 50,
        idleTimeoutMs: 300000,
        hangTimeoutMs: 300000,
        permissionMode: 'dangerously-skip',
      },
      users: {
        '1': { model: 'claude-sonnet-4-20250514', repo: '/override' },
      },
    };
    const resolved = resolveUserConfig(agent, '1');
    expect(resolved.model).toBe('claude-sonnet-4-20250514');
    expect(resolved.repo).toBe('/override');
  });
});

describe('diffConfigs', () => {
  const baseConfig = validateConfig(VALID_CONFIG);

  it('detects added agents', () => {
    const newConfig = validateConfig({
      ...VALID_CONFIG,
      agents: {
        ...VALID_CONFIG.agents,
        work: {
          botToken: 'test-token-2',
          allowedUsers: ['789'],
        },
      },
    });
    const diff = diffConfigs(baseConfig, newConfig);
    expect(diff.added).toContain('work');
    expect(diff.removed).toHaveLength(0);
  });

  it('detects removed agents', () => {
    const newConfig = validateConfig({
      global: VALID_CONFIG.global,
      agents: {
        other: {
          botToken: 'test-token-3',
          allowedUsers: ['456'],
        },
      },
    });
    const diff = diffConfigs(baseConfig, newConfig);
    expect(diff.removed).toContain('personal');
    expect(diff.added).toContain('other');
  });

  it('detects changed agents', () => {
    const modifiedConfig = JSON.parse(JSON.stringify(VALID_CONFIG));
    modifiedConfig.agents.personal.defaults.model = 'claude-haiku-4-5';
    const newConfig = validateConfig(modifiedConfig);
    const diff = diffConfigs(baseConfig, newConfig);
    expect(diff.changed).toContain('personal');
  });

  it('reports no changes for identical configs', () => {
    const diff = diffConfigs(baseConfig, baseConfig);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
  });
});

describe('repo registry', () => {
  it('parses top-level repos map', () => {
    const config = validateConfig({
      repos: {
        tgcc: '/home/fonz/tgcc',
        kyo: '/home/fonz/kyo',
      },
      agents: {
        test: { botToken: 'tok', allowedUsers: ['1'] },
      },
    });
    expect(config.repos.tgcc).toBe('/home/fonz/tgcc');
    expect(config.repos.kyo).toBe('/home/fonz/kyo');
  });

  it('resolves agent defaults.repo from repos registry', () => {
    const config = validateConfig({
      repos: { tgcc: '/home/fonz/tgcc' },
      agents: {
        test: {
          botToken: 'tok',
          allowedUsers: ['1'],
          defaults: { repo: 'tgcc' },
        },
      },
    });
    expect(config.agents.test.defaults.repo).toBe('/home/fonz/tgcc');
  });

  it('preserves direct paths for defaults.repo not in registry', () => {
    const config = validateConfig({
      repos: {},
      agents: {
        test: {
          botToken: 'tok',
          allowedUsers: ['1'],
          defaults: { repo: '/direct/path' },
        },
      },
    });
    expect(config.agents.test.defaults.repo).toBe('/direct/path');
  });

  it('rejects duplicate repo assignment (exclusivity)', () => {
    expect(() => validateConfig({
      repos: { tgcc: '/home/fonz/tgcc' },
      agents: {
        a: { botToken: 'tok1', allowedUsers: ['1'], defaults: { repo: 'tgcc' } },
        b: { botToken: 'tok2', allowedUsers: ['1'], defaults: { repo: 'tgcc' } },
      },
    })).toThrow('already assigned');
  });

  it('allows agents without repo (generic agents)', () => {
    const config = validateConfig({
      repos: { tgcc: '/home/fonz/tgcc' },
      agents: {
        bound: { botToken: 'tok1', allowedUsers: ['1'], defaults: { repo: 'tgcc' } },
        generic: { botToken: 'tok2', allowedUsers: ['1'] },
      },
    });
    expect(config.agents.bound.defaults.repo).toBe('/home/fonz/tgcc');
    // generic gets default repo (homedir)
    expect(config.agents.generic.defaults.repo).not.toBe('/home/fonz/tgcc');
  });

  it('defaults to empty repos when not provided', () => {
    const config = validateConfig({
      agents: { test: { botToken: 'tok', allowedUsers: ['1'] } },
    });
    expect(config.repos).toEqual({});
  });
});

describe('resolveRepoPath', () => {
  const repos = { tgcc: '/home/fonz/tgcc', kyo: '/home/fonz/kyo' };

  it('resolves a registry key to its path', () => {
    expect(resolveRepoPath(repos, 'tgcc')).toBe('/home/fonz/tgcc');
  });

  it('returns direct path if not in registry', () => {
    expect(resolveRepoPath(repos, '/some/other/path')).toBe('/some/other/path');
  });
});

describe('agentForRepo', () => {
  it('finds agent by exact repo path', () => {
    const config = validateConfig({
      repos: { tgcc: '/home/fonz/tgcc' },
      agents: {
        test: { botToken: 'tok', allowedUsers: ['1'], defaults: { repo: 'tgcc' } },
      },
    });
    expect(agentForRepo(config, '/home/fonz/tgcc')).toBe('test');
  });

  it('finds agent for cwd inside repo path', () => {
    const config = validateConfig({
      repos: { tgcc: '/home/fonz/tgcc' },
      agents: {
        test: { botToken: 'tok', allowedUsers: ['1'], defaults: { repo: 'tgcc' } },
      },
    });
    expect(agentForRepo(config, '/home/fonz/tgcc/src')).toBe('test');
  });

  it('returns null for unmatched path', () => {
    const config = validateConfig({
      repos: { tgcc: '/home/fonz/tgcc' },
      agents: {
        test: { botToken: 'tok', allowedUsers: ['1'], defaults: { repo: 'tgcc' } },
      },
    });
    expect(agentForRepo(config, '/home/fonz/other')).toBeNull();
  });
});
