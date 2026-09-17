import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { updateConfig, isValidRepoName, findRepoOwner, CONFIG_PATH } from '../src/config.js';

// `CONFIG_PATH` is a module-level constant (`join(homedir(), '.tgcc', 'config.json')`) with no
// override parameter, so the only way to redirect `updateConfig()` — the function under test
// below — is to control what `homedir()` itself resolves to. vitest.config.ts's own `test.env`
// does exactly that for the whole suite (a fresh, disposable HOME per run, set before any test
// module is imported) — see its comment for the real-config-corruption incident that made that
// necessary. This file used to read/write CONFIG_PATH directly with NO redirection at all
// (silently relying on whatever `~/.tgcc/config.json` happened to exist on the machine running
// the tests, backing it up and restoring it around each test) — that's exactly what caused it.
// It's fixed here to seed a known-good, throwaway config into the (now-sandboxed) CONFIG_PATH
// itself before every test, rather than depending on — or risking — a real one.

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
  // Resolves into vitest.config.ts's sandboxed HOME — never the real ~/.tgcc/config.json. Seeded
  // fresh before every test (not just once) so tests never depend on execution order or leftover
  // state from a previous test/run, and always includes one agent so "assigns a repo to an
  // agent" / "clears an agent repo assignment" below exercise their real logic rather than
  // silently skipping when no agents happen to be configured.
  const origConfigPath = CONFIG_PATH;
  const seedConfig = {
    repos: {},
    agents: {
      seedagent: { botToken: 'seed-token', allowedUsers: ['1'], defaults: { model: 'test' } },
    },
  };

  beforeEach(() => {
    mkdirSync(dirname(origConfigPath), { recursive: true });
    writeFileSync(origConfigPath, JSON.stringify(seedConfig, null, 2));
  });

  afterEach(() => {
    if (existsSync(origConfigPath)) rmSync(origConfigPath, { force: true });
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
