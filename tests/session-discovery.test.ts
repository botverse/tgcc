// tests/session-discovery.test.ts
//
// Regression tests for src/session.ts's pure, exported session-discovery
// primitives (discoverCCSessions, getSessionJsonlPath, computeProjectSlug,
// getSessionEndState) and SessionStore's per-chat tracking.
//
// These lock down behavior that is NOT changing as part of the "color agent
// adopted a foreign session" bug fix (session.ts is untouched by that fix as
// of writing), so they're safe to land ahead of tgcc-src's change. Tests that
// exercise the actual ownership/adoption fix live in
// tests/session-ownership.test.ts and are written against the interface
// tgcc-src announces.
//
// All fixtures live under a fresh os.tmpdir() directory per test and pass an
// explicit `configDir` so nothing here reads or writes ~/.claude or ~/.tgcc.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import {
  discoverCCSessions,
  getSessionJsonlPath,
  computeProjectSlug,
  getSessionEndState,
  SessionStore,
} from '../src/session.js';

const logger = pino({ level: 'silent' });

// ── Fixture helpers ──

let tmpDir: string;
let configDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tgcc-session-discovery-'));
  configDir = join(tmpDir, '.claude');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const REPO = '/home/fonz/Projects/color';
const SLUG = computeProjectSlug(REPO);

function projectDir(): string {
  return join(configDir, 'projects', SLUG);
}

/** Write a minimal but realistic session JSONL: a real user message (so title
 *  extraction doesn't produce 'untitled'), optionally followed by an assistant
 *  reply. `isSidechain` / ralph-prefixed text are supported via options. */
function writeSessionJsonl(
  sessionId: string,
  opts: {
    userText?: string;
    isSidechain?: boolean;
    mtime?: Date;
    dir?: string;
    filenameOverride?: string;
  } = {},
): string {
  const dir = opts.dir ?? projectDir();
  mkdirSync(dir, { recursive: true });
  const filename = opts.filenameOverride ?? `${sessionId}.jsonl`;
  const path = join(dir, filename);

  const lines: string[] = [];
  const userText = opts.userText ?? 'Hello, please help me with something.';
  lines.push(
    JSON.stringify({
      type: 'user',
      isSidechain: !!opts.isSidechain,
      message: { role: 'user', content: userText },
    }),
  );
  lines.push(
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure thing.' }] },
    }),
  );
  writeFileSync(path, lines.join('\n') + '\n');

  if (opts.mtime) {
    utimesSync(path, opts.mtime, opts.mtime);
  }
  return path;
}

// ── computeProjectSlug ──

describe('computeProjectSlug', () => {
  it('replaces / and . with -', () => {
    expect(computeProjectSlug('/home/fonz/Projects/color')).toBe('-home-fonz-Projects-color');
  });

  it('hashes and truncates very long paths', () => {
    const longPath = '/home/fonz/' + 'a'.repeat(80);
    const slug = computeProjectSlug(longPath);
    expect(slug.length).toBeLessThanOrEqual(50);
    // Deterministic — same input always produces the same slug.
    expect(computeProjectSlug(longPath)).toBe(slug);
  });

  it('empty repo produces an empty slug (not the projects root)', () => {
    // Regression guard: computeProjectSlug('') must stay '', and callers must
    // never join('') expecting it to resolve to a specific per-repo directory —
    // join(base, 'projects', '') resolves to the *projects root*, which holds
    // every agent's/every repo's sessions. See the empty-repo describe block
    // below for the discoverCCSessions-level guarantee this implies.
    expect(computeProjectSlug('')).toBe('');
  });
});

// ── getSessionJsonlPath ──

describe('getSessionJsonlPath', () => {
  it('builds <configDir>/projects/<slug>/<sessionId>.jsonl', () => {
    const path = getSessionJsonlPath('abc-123', REPO, configDir);
    expect(path).toBe(join(configDir, 'projects', SLUG, 'abc-123.jsonl'));
  });
});

// ── discoverCCSessions: basic discovery ──

describe('discoverCCSessions — basic discovery', () => {
  it('returns [] when the project dir does not exist', () => {
    expect(discoverCCSessions(REPO, 10, configDir)).toEqual([]);
  });

  it('finds a real session with a valid UUID filename', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    writeSessionJsonl(id);
    const found = discoverCCSessions(REPO, 10, configDir);
    expect(found.map(s => s.id)).toEqual([id]);
  });

  it('ignores non-.jsonl files and non-UUID filenames', () => {
    mkdirSync(projectDir(), { recursive: true });
    writeFileSync(join(projectDir(), 'notes.txt'), 'hello');
    writeSessionJsonl('not-a-uuid', { filenameOverride: 'not-a-uuid.jsonl' });
    expect(discoverCCSessions(REPO, 10, configDir)).toEqual([]);
  });

  it('sorts by most-recently-modified first', () => {
    const older = '22222222-2222-4222-8222-222222222222';
    const newer = '33333333-3333-4333-8333-333333333333';
    writeSessionJsonl(older, { mtime: new Date(Date.now() - 60_000) });
    writeSessionJsonl(newer, { mtime: new Date() });
    const found = discoverCCSessions(REPO, 10, configDir);
    expect(found.map(s => s.id)).toEqual([newer, older]);
  });
});

// ── discoverCCSessions: existing exclusion rules (lock down, don't regress) ──

describe('discoverCCSessions — exclusion rules', () => {
  it('excludes agent-*.jsonl (sub-agent transcripts) regardless of UUID validity', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    writeSessionJsonl(id, { filenameOverride: `agent-${id}.jsonl` });
    expect(discoverCCSessions(REPO, 10, configDir)).toEqual([]);
  });

  it('excludes sidechain sessions (sub-agent transcript forks)', () => {
    const id = '55555555-5555-4555-8555-555555555555';
    writeSessionJsonl(id, { isSidechain: true });
    expect(discoverCCSessions(REPO, 10, configDir)).toEqual([]);
  });

  it('excludes sessions whose first real user message starts with "You are Ralph" (ralph sessions)', () => {
    const id = '66666666-6666-4666-8666-666666666666';
    writeSessionJsonl(id, { userText: 'You are Ralph, a relentless quality gate. Go watch agent "color".' });
    expect(discoverCCSessions(REPO, 10, configDir)).toEqual([]);
  });

  it('excludes sessions older than 30 days', () => {
    const id = '77777777-7777-4777-8777-777777777777';
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    writeSessionJsonl(id, { mtime: old });
    expect(discoverCCSessions(REPO, 10, configDir)).toEqual([]);
  });

  it('excludes sessions with no real user message ("untitled")', () => {
    const id = '88888888-8888-4888-8888-888888888888';
    mkdirSync(projectDir(), { recursive: true });
    const path = join(projectDir(), `${id}.jsonl`);
    // Only a file-history-snapshot line — extractSessionMeta will never find
    // a real user message and title stays 'untitled'.
    writeFileSync(path, JSON.stringify({ type: 'file-history-snapshot' }) + '\n');
    expect(discoverCCSessions(REPO, 10, configDir)).toEqual([]);
  });
});

// ── discoverCCSessions: empty/missing repo must not scan the wrong dir ──

describe('discoverCCSessions — empty repo guard', () => {
  it('an empty repo does not fall through to scanning every repo under projects/', () => {
    // Two *other* repos each have a real session. If discoverCCSessions('')
    // ever resolved to the projects root instead of a specific repo slug dir,
    // readdirSync would see repo subdirectories (not .jsonl files) — this
    // asserts that stays a no-op rather than silently starting to recurse.
    const otherRepoA = join(configDir, 'projects', computeProjectSlug('/home/fonz/Projects/other-a'));
    const otherRepoB = join(configDir, 'projects', computeProjectSlug('/home/fonz/Projects/other-b'));
    writeSessionJsonl('99999999-9999-4999-8999-999999999999', { dir: otherRepoA });
    writeSessionJsonl('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', { dir: otherRepoB });

    expect(() => discoverCCSessions('', 10, configDir)).not.toThrow();
    expect(discoverCCSessions('', 10, configDir)).toEqual([]);
  });
});

// ── getSessionEndState ──

describe('getSessionEndState', () => {
  function write(lines: unknown[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'tgcc-endstate-'));
    const path = join(dir, 'session.jsonl');
    const text = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
    writeFileSync(path, text);
    return path;
  }

  it('returns "completed" when the last assistant turn ended with end_turn', () => {
    const path = write([
      { type: 'user', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
    ]);
    expect(getSessionEndState(path, statSync(path).size)).toBe('completed');
  });

  it('returns "interrupted" when the last entry is a user message CC never answered', () => {
    const path = write([
      { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn' } },
      { type: 'user', message: { role: 'user', content: 'one more thing' } },
    ]);
    expect(getSessionEndState(path, statSync(path).size)).toBe('interrupted');
  });

  it('returns "unknown" for an empty/unparseable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgcc-endstate-empty-'));
    const path = join(dir, 'session.jsonl');
    writeFileSync(path, '');
    expect(getSessionEndState(path, 0)).toBe('unknown');
  });
});

// ── SessionStore: per-chat session tracking ──

describe('SessionStore — per-chat session tracking', () => {
  let storeDir: string;
  let store: SessionStore;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'tgcc-sessionstore-'));
    store = new SessionStore(join(storeDir, 'state.json'), logger);
  });

  afterEach(() => {
    rmSync(storeDir, { recursive: true, force: true });
  });

  it('getSessionForChat returns undefined when nothing is tracked', () => {
    expect(store.getSessionForChat('color', 7016073156)).toBeUndefined();
  });

  it('round-trips a session id for a chat', () => {
    store.setSessionForChat('color', 7016073156, 'a6b7eab0-bad4-4672-a1c7-07666173fd7e');
    expect(store.getSessionForChat('color', 7016073156)).toBe('a6b7eab0-bad4-4672-a1c7-07666173fd7e');
  });

  it('tracks each chat independently — one chat is never affected by another chat\'s session', () => {
    store.setSessionForChat('color', 111, 'session-for-111');
    store.setSessionForChat('color', 222, 'session-for-222');
    expect(store.getSessionForChat('color', 111)).toBe('session-for-111');
    expect(store.getSessionForChat('color', 222)).toBe('session-for-222');
  });

  it('tracks each agent independently — same chatId under two agents does not collide', () => {
    store.setSessionForChat('color', 111, 'color-session');
    store.setSessionForChat('other-agent', 111, 'other-agent-session');
    expect(store.getSessionForChat('color', 111)).toBe('color-session');
    expect(store.getSessionForChat('other-agent', 111)).toBe('other-agent-session');
  });

  it('clearSessionForChat removes only the targeted chat', () => {
    store.setSessionForChat('color', 111, 'keep-me');
    store.setSessionForChat('color', 222, 'drop-me');
    store.clearSessionForChat('color', 222);
    expect(store.getSessionForChat('color', 111)).toBe('keep-me');
    expect(store.getSessionForChat('color', 222)).toBeUndefined();
  });

  it('persists sessionsByChat across store instances (survives a restart)', () => {
    const stateFile = join(storeDir, 'state.json');
    store.setSessionForChat('color', 7016073156, 'a6b7eab0-bad4-4672-a1c7-07666173fd7e');

    const reloaded = new SessionStore(stateFile, logger);
    expect(reloaded.getSessionForChat('color', 7016073156)).toBe('a6b7eab0-bad4-4672-a1c7-07666173fd7e');
  });

  it('an agent with an empty repo still tracks/returns per-chat sessions correctly (repo and session tracking are independent fields)', () => {
    store.setRepo('color', '');
    store.setSessionForChat('color', 7016073156, 'a6b7eab0-bad4-4672-a1c7-07666173fd7e');
    expect(store.getAgent('color').repo).toBe('');
    expect(store.getSessionForChat('color', 7016073156)).toBe('a6b7eab0-bad4-4672-a1c7-07666173fd7e');
  });
});
