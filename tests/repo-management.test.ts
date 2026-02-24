import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { updateConfig, isValidRepoName, findRepoOwner, CONFIG_PATH } from '../src/config.js';

// Use a temp config for tests
const TEST_DIR = join(tmpdir(), 'tgcc-test-' + process.pid);
const TEST_CONFIG = join(TEST_DIR, 'config.json');

// We need to override CONFIG_PATH for updateConfig.
// Since CONFIG_PATH is a const export, we'll test updateConfig indirectly
// by providing a minimal test that exercises the logic.

describe('isValidRepoName', () => {
  it('accepts alphanumeric names', () => {
    expect(isValidRepoName('myrepo')).toBe(true);
    expect(isValidRepoName('my-repo')).toBe(true);
    expect(isValidRepoName('repo123')).toBe(true);
    expect(isValidRepoName('My-Repo-2')).toBe(true);
  });

  it('rejects invalid names', () => {
    expect(isValidRepoName('')).toBe(false);
    expect(isValidRepoName('-starts-with-dash')).toBe(false);
    expect(isValidRepoName('has spaces')).toBe(false);
    expect(isValidRepoName('has/slash')).toBe(false);
    expect(isValidRepoName('has.dot')).toBe(false);
    expect(isValidRepoName('has_underscore')).toBe(false);
  });
});

describe('findRepoOwner', () => {
  it('returns agent that owns the repo', () => {
    const raw = {
      repos: { 'my-repo': '/some/path' },
      agents: {
        agent1: { botToken: 'tok1', allowedUsers: ['1'], defaults: { repo: 'my-repo' } },
        agent2: { botToken: 'tok2', allowedUsers: ['2'], defaults: { model: 'test' } },
      },
    };
    expect(findRepoOwner(raw, 'my-repo')).toBe('agent1');
  });

  it('returns null when no agent owns it', () => {
    const raw = {
      repos: { 'my-repo': '/some/path' },
      agents: {
        agent1: { botToken: 'tok1', allowedUsers: ['1'], defaults: { model: 'test' } },
      },
    };
    expect(findRepoOwner(raw, 'my-repo')).toBeNull();
  });

  it('returns null for non-existent repo', () => {
    const raw = {
      repos: {},
      agents: {
        agent1: { botToken: 'tok1', allowedUsers: ['1'], defaults: { repo: 'other' } },
      },
    };
    expect(findRepoOwner(raw, 'nonexistent')).toBeNull();
  });
});

describe('updateConfig', () => {
  const origConfigPath = CONFIG_PATH;
  let backupContent: string | null = null;

  beforeEach(() => {
    // Backup existing config
    if (existsSync(origConfigPath)) {
      backupContent = readFileSync(origConfigPath, 'utf-8');
    }
  });

  afterEach(() => {
    // Restore
    if (backupContent !== null) {
      writeFileSync(origConfigPath, backupContent);
    }
  });

  it('adds a repo to config', () => {
    const before = JSON.parse(readFileSync(origConfigPath, 'utf-8'));
    const testRepoName = '__test_repo_' + Date.now();

    updateConfig((cfg) => {
      const repos = (cfg.repos ?? {}) as Record<string, string>;
      repos[testRepoName] = '/tmp/test-path';
      cfg.repos = repos;
    });

    const after = JSON.parse(readFileSync(origConfigPath, 'utf-8'));
    expect(after.repos[testRepoName]).toBe('/tmp/test-path');

    // Clean up: remove the test repo
    updateConfig((cfg) => {
      const repos = (cfg.repos ?? {}) as Record<string, string>;
      delete repos[testRepoName];
      cfg.repos = repos;
    });
  });

  it('removes a repo from config', () => {
    const testRepoName = '__test_repo_rm_' + Date.now();

    // Add first
    updateConfig((cfg) => {
      const repos = (cfg.repos ?? {}) as Record<string, string>;
      repos[testRepoName] = '/tmp/test-rm';
      cfg.repos = repos;
    });

    // Remove
    updateConfig((cfg) => {
      const repos = (cfg.repos ?? {}) as Record<string, string>;
      delete repos[testRepoName];
      cfg.repos = repos;
    });

    const after = JSON.parse(readFileSync(origConfigPath, 'utf-8'));
    expect(after.repos?.[testRepoName]).toBeUndefined();
  });

  it('assigns a repo to an agent', () => {
    const before = JSON.parse(readFileSync(origConfigPath, 'utf-8'));
    const agentIds = Object.keys(before.agents ?? {});
    if (agentIds.length === 0) return; // skip if no agents

    const agentId = agentIds[0];
    const testRepoName = '__test_assign_' + Date.now();

    // Add repo
    updateConfig((cfg) => {
      const repos = (cfg.repos ?? {}) as Record<string, string>;
      repos[testRepoName] = '/tmp/test-assign';
      cfg.repos = repos;
    });

    // Assign
    updateConfig((cfg) => {
      const agents = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>;
      const a = agents[agentId];
      if (a) {
        const defaults = (a.defaults ?? {}) as Record<string, unknown>;
        defaults.repo = testRepoName;
        a.defaults = defaults;
      }
    });

    const after = JSON.parse(readFileSync(origConfigPath, 'utf-8'));
    expect((after.agents[agentId].defaults as Record<string, unknown>).repo).toBe(testRepoName);

    // Verify findRepoOwner
    expect(findRepoOwner(after, testRepoName)).toBe(agentId);
  });

  it('clears an agent repo assignment', () => {
    const before = JSON.parse(readFileSync(origConfigPath, 'utf-8'));
    const agentIds = Object.keys(before.agents ?? {});
    if (agentIds.length === 0) return;

    const agentId = agentIds[0];

    // Clear
    updateConfig((cfg) => {
      const agents = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>;
      const a = agents[agentId];
      if (a) {
        const defaults = (a.defaults ?? {}) as Record<string, unknown>;
        delete defaults.repo;
        a.defaults = defaults;
      }
    });

    const after = JSON.parse(readFileSync(origConfigPath, 'utf-8'));
    expect((after.agents[agentId].defaults as Record<string, unknown>).repo).toBeUndefined();
  });
});
