// tests/auto-resume.test.ts
//
// Regression tests for the "color agent adopted a foreign session" bug as it survives
// in the PER-CHAT TRACKED-SESSION path — tests/session-ownership.test.ts and
// tests/session-discovery.test.ts already lock down the DISCOVERY path
// (discoverCCSessions / isRemoteControlSession as pure functions), but the actual
// reported incident was that agent "color" had a foreign interactive session id already
// PERSISTED in state.json's agents.color.sessionsByChat, and Bridge.autoResumeSessions()
// resumed it (and nudged it) on every restart without ever calling isRemoteControlSession
// — discovery-side filtering never runs for a tracked id, only for directory-mtime scans.
//
// Fix under test (uncommitted, from tgcc-src — read directly from `git diff src/bridge.ts`):
//   autoResumeSessions() now calls isRemoteControlSession(jsonlPath, size) at BOTH
//   auto-resume sites before trusting a session id:
//     1. the per-chat tracked loop (state.json's sessionsByChat) — clears tracking and
//        skips when the marker is found (bridge.ts ~854-864)
//     2. the legacy lastSessionId fallback (pre-per-chat-refactor agents) — skips
//        (without clearing) when the marker is found (bridge.ts ~906-909)
//
// autoResumeSessions() is a private Bridge method, and Bridge's constructor is not
// designed for dependency injection: RalphManager/ExternalCcManager are wired to
// join(homedir(), '.tgcc', ...) with NO override parameter. To stay hermetic (never
// touch the real ~/.tgcc or ~/.claude — there is a live incident involving exactly
// those paths) this file mocks node:os's `homedir()` for the whole file, redirecting
// every homedir()-based path (Bridge's RalphManager/ExternalCcManager persistence,
// session.ts's default `~/.claude` config dir) into a fresh os.tmpdir() directory per
// test. This lets us construct a real Bridge and invoke the real, unmodified
// autoResumeSessions() — not a reimplementation of its logic — while remaining fully
// hermetic. `agents` (populated only by the private startAgent, which spins up a real
// grammy Bot) is filled by hand with a plain object satisfying the fields
// autoResumeSessions actually touches; sendToCC is stubbed to capture nudges without
// spawning a real CC process.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';

let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

const { Bridge } = await import('../src/bridge.js');
const { computeProjectSlug } = await import('../src/session.js');
const { wrapSystemReminder } = await import('../src/cc-tags.js');

const logger = pino({ level: 'silent' });
const AGENT_ID = 'testAgent';
const CHAT_ID = 7016073156; // same chat id shape as the real bug report

let tmpDir: string;
let repo: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tgcc-auto-resume-'));
  fakeHome = tmpDir; // every homedir()-based path in Bridge/session.ts now resolves here
  repo = join(tmpDir, 'repo', 'color');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ── Fixture helpers ──

function projectDir(): string {
  return join(fakeHome, '.claude', 'projects', computeProjectSlug(repo));
}

function bridgeSessionMarkerLine(sessionId: string): string {
  return JSON.stringify({ type: 'bridge-session', sessionId, bridgeSessionId: 'cse_abc123', lastSequenceNum: 0 });
}

function userLine(text = 'hello'): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function completedAssistantLine(): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure.' }] } });
}

/** Write a session JSONL ending on an unanswered user turn — getSessionEndState → 'interrupted'. */
function writeInterruptedSession(sessionId: string, markerLines: string[] = []): string {
  return writeJsonl(sessionId, [...markerLines, userLine('please keep going'), completedAssistantLine(), userLine('one more thing')]);
}

/** Write a session JSONL ending on a clean assistant end_turn — getSessionEndState → 'completed'. */
function writeCompletedSession(sessionId: string, markerLines: string[] = []): string {
  return writeJsonl(sessionId, [...markerLines, userLine('hello, please help'), completedAssistantLine()]);
}

function writeJsonl(sessionId: string, lines: string[], mtime: Date = new Date()): string {
  const dir = projectDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  utimesSync(path, mtime, mtime);
  return path;
}

// ── Bridge construction (hermetic — no grammy Bot, no real ~/.tgcc or ~/.claude) ──

function buildConfig() {
  return {
    global: {
      ccBinaryPath: 'claude',
      mediaDir: join(tmpDir, 'media'),
      socketDir: join(tmpDir, 'sockets'),
      ctlSocketDir: join(tmpDir, 'ctl'),
      mcpConfigDir: join(tmpDir, 'mcp'),
      logLevel: 'silent',
      stateFile: join(tmpDir, '.tgcc-state', 'state.json'),
      authFallbackEnabled: false,
      authFallbackTimeoutMs: 300000,
      tmux: false,
    },
    repos: { color: repo },
    agents: {
      [AGENT_ID]: {
        botToken: 'x',
        allowedUsers: ['1'],
        defaults: {
          model: 'sonnet',
          repo,
          idleTimeoutMs: 100,
          hangTimeoutMs: 100,
          permissionMode: 'default' as const,
        },
      },
    },
    supervisor: null,
  };
}

/** Construct a real Bridge and hand-populate `agents` the way startAgent() would, minus
 *  the grammy Bot (autoResumeSessions never touches tgBot directly — nudges go through
 *  sendToCC, which we stub). Returns the bridge cast to `any` since AgentInstance/
 *  autoResumeSessions are private/unexported — this is the seam the codebase provides. */
function buildBridge(): any {
  const config = buildConfig();
  const bridge = new Bridge(config as any, logger) as any;
  bridge.agents.set(AGENT_ID, {
    id: AGENT_ID,
    config: config.agents[AGENT_ID],
    tgBot: null,
    ephemeral: false,
    repo,
    model: 'sonnet',
    chatSessions: new Map(),
    pendingPermissions: new Map(),
    pendingExecApprovals: new Map(),
    lastTgChatId: CHAT_ID,
    lastTgUserId: null,
    destroyTimer: null,
    eventBuffer: null,
    awaitingAskCleanup: false,
    muteOutput: false,
    authFlowInProgress: false,
    lastSendData: null,
    claudeConfigDir: undefined,
    pendingCliTmuxAgent: null,
  });
  bridge.sendToCC = vi.fn(async () => {});
  return bridge;
}

const nudgeText = wrapSystemReminder('TGCC restarted while you were mid-turn. Your previous session has been resumed. Continue where you left off.');

// ── 1. The exact reported bug: a poisoned per-chat tracked id ──

describe('autoResumeSessions — foreign remote-control session in sessionsByChat (exact bug repro)', () => {
  it('is NOT resumed and produces NO nudge; tracking is cleared', () => {
    const foreignId = 'a6b7eab0-bad4-4672-a1c7-07666173fd7e';
    writeJsonl(foreignId, [bridgeSessionMarkerLine(foreignId), userLine('unrelated human chat'), completedAssistantLine()]);

    const bridge = buildBridge();
    bridge.sessionStore.setSessionForChat(AGENT_ID, CHAT_ID, foreignId);

    expect(() => bridge.autoResumeSessions()).not.toThrow();

    // No resume: no pending session prepared for this chat.
    const agent = bridge.agents.get(AGENT_ID);
    expect(agent.chatSessions.get(CHAT_ID)).toBeUndefined();
    // No nudge, no CC wake at all.
    expect(bridge.sendToCC).not.toHaveBeenCalled();
    // Tracking cleared — not left pointing at the foreign session forever.
    expect(bridge.sessionStore.getSessionForChat(AGENT_ID, CHAT_ID)).toBeUndefined();
  });

  it('still clears tracking (and does not resume) even when the foreign session ended mid-turn (would otherwise nudge)', () => {
    // The dangerous case: if isRemoteControlSession weren't checked, an "interrupted"
    // foreign session is exactly what would trigger sendToCC with a nudge — injecting
    // TGCC's continuation prompt into a human's own interactive terminal session.
    const foreignId = 'b6b7eab0-bad4-4672-a1c7-07666173fd7f';
    writeJsonl(foreignId, [bridgeSessionMarkerLine(foreignId), userLine('human typed something and left')]);

    const bridge = buildBridge();
    bridge.sessionStore.setSessionForChat(AGENT_ID, CHAT_ID, foreignId);

    bridge.autoResumeSessions();

    expect(bridge.sendToCC).not.toHaveBeenCalled();
    expect(bridge.sessionStore.getSessionForChat(AGENT_ID, CHAT_ID)).toBeUndefined();
  });

  it('detects the alternate "subtype":"bridge_status" marker form too', () => {
    const foreignId = 'c6b7eab0-bad4-4672-a1c7-07666173fd70';
    writeJsonl(foreignId, [JSON.stringify({ type: 'system', subtype: 'bridge_status', message: 'connected' }), userLine('hi'), completedAssistantLine()]);

    const bridge = buildBridge();
    bridge.sessionStore.setSessionForChat(AGENT_ID, CHAT_ID, foreignId);

    bridge.autoResumeSessions();

    expect(bridge.sendToCC).not.toHaveBeenCalled();
    expect(bridge.sessionStore.getSessionForChat(AGENT_ID, CHAT_ID)).toBeUndefined();
  });
});

// ── 2. Guard against over-correcting: genuine TGCC sessions must still resume ──

describe('autoResumeSessions — genuine TGCC-created tracked session', () => {
  it('IS resumed (pendingSessionId set, tracking kept) and does NOT nudge when it ended cleanly', () => {
    const ownId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeCompletedSession(ownId);

    const bridge = buildBridge();
    bridge.sessionStore.setSessionForChat(AGENT_ID, CHAT_ID, ownId);

    bridge.autoResumeSessions();

    const agent = bridge.agents.get(AGENT_ID);
    const cs = agent.chatSessions.get(CHAT_ID);
    expect(cs).toBeDefined();
    expect(cs.pendingSessionId).toBe(ownId);
    expect(cs.forceNewSession).toBe(false);
    expect(bridge.sessionStore.getSessionForChat(AGENT_ID, CHAT_ID)).toBe(ownId);
    expect(bridge.sendToCC).not.toHaveBeenCalled();
  });

  it('IS resumed AND sends the continuation nudge when it was interrupted mid-turn', () => {
    const ownId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    writeInterruptedSession(ownId);

    const bridge = buildBridge();
    bridge.sessionStore.setSessionForChat(AGENT_ID, CHAT_ID, ownId);

    bridge.autoResumeSessions();

    const agent = bridge.agents.get(AGENT_ID);
    const cs = agent.chatSessions.get(CHAT_ID);
    expect(cs.pendingSessionId).toBe(ownId);
    expect(bridge.sessionStore.getSessionForChat(AGENT_ID, CHAT_ID)).toBe(ownId);
    expect(bridge.sendToCC).toHaveBeenCalledTimes(1);
    expect(bridge.sendToCC).toHaveBeenCalledWith(
      AGENT_ID,
      { text: nudgeText },
      { chatId: CHAT_ID },
    );
  });
});

// ── 3. Missing JSONL clears tracking, and does not fall through to a foreign session ──

describe('autoResumeSessions — tracked id whose JSONL is missing', () => {
  it('clears tracking, does not crash, and does not adopt anything', () => {
    const goneId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    // Deliberately do NOT write a JSONL for goneId.

    const bridge = buildBridge();
    bridge.sessionStore.setSessionForChat(AGENT_ID, CHAT_ID, goneId);

    expect(() => bridge.autoResumeSessions()).not.toThrow();

    const agent = bridge.agents.get(AGENT_ID);
    expect(agent.chatSessions.get(CHAT_ID)).toBeUndefined();
    expect(bridge.sessionStore.getSessionForChat(AGENT_ID, CHAT_ID)).toBeUndefined();
    expect(bridge.sendToCC).not.toHaveBeenCalled();
  });

  it('does not fall through to a foreign remote-control session sitting in the same project dir', () => {
    // Reproduces the fear behind "falls through to something foreign": a missing
    // tracked JSONL sits next to an unrelated, newer, foreign remote-control session
    // in the same project dir. Naive "pick something else to resume" logic would grab
    // it; the real fix only ever trusts explicit tracked/legacy ids, never mtime scans.
    const goneId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const foreignId = 'a1111111-1111-4111-8111-111111111111';
    writeJsonl(foreignId, [bridgeSessionMarkerLine(foreignId), userLine('an unrelated interactive session'), completedAssistantLine()]);

    const bridge = buildBridge();
    bridge.sessionStore.setSessionForChat(AGENT_ID, CHAT_ID, goneId);

    bridge.autoResumeSessions();

    const agent = bridge.agents.get(AGENT_ID);
    const cs = agent.chatSessions.get(CHAT_ID);
    expect(cs).toBeUndefined();
    expect(bridge.sessionStore.getSessionForChat(AGENT_ID, CHAT_ID)).toBeUndefined();
    expect(bridge.sendToCC).not.toHaveBeenCalled();
  });
});

// ── 4. Stale legacy lastSessionId with no JSONL on disk ──

describe('autoResumeSessions — legacy lastSessionId (pre-per-chat-refactor) fallback', () => {
  it('a lastSessionId with no JSONL on disk is neither adopted nor crashes', () => {
    const legacyId = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
    // No sessionsByChat tracking at all for this agent — forces the legacy fallback path.
    // Deliberately do NOT write a JSONL for legacyId.

    const bridge = buildBridge();
    bridge.sessionStore.setLastSessionId(AGENT_ID, legacyId);

    expect(() => bridge.autoResumeSessions()).not.toThrow();

    const agent = bridge.agents.get(AGENT_ID);
    expect(agent.chatSessions.size).toBe(0);
    expect(bridge.sendToCC).not.toHaveBeenCalled();
  });

  it('a foreign remote-control legacy lastSessionId is skipped, not resumed (fix site #2)', () => {
    const legacyForeignId = 'cccccccc-2222-4ccc-8ccc-cccccccccccc';
    writeJsonl(legacyForeignId, [bridgeSessionMarkerLine(legacyForeignId), userLine('interactive human session'), completedAssistantLine()]);

    const bridge = buildBridge();
    bridge.sessionStore.setLastSessionId(AGENT_ID, legacyForeignId);

    bridge.autoResumeSessions();

    const agent = bridge.agents.get(AGENT_ID);
    expect(agent.chatSessions.size).toBe(0);
    expect(bridge.sendToCC).not.toHaveBeenCalled();
  });

  it('a genuine legacy lastSessionId (real JSONL, no marker) IS still resumed onto the fallback chat', () => {
    const legacyId = 'dddddddd-3333-4ddd-8ddd-dddddddddddd';
    writeCompletedSession(legacyId);

    const bridge = buildBridge();
    bridge.sessionStore.setLastSessionId(AGENT_ID, legacyId);

    bridge.autoResumeSessions();

    const agent = bridge.agents.get(AGENT_ID);
    // No per-chat tracking existed, so the legacy path attaches to getAgentChatId()'s
    // resolution — here agent.lastTgChatId, which buildBridge() sets to CHAT_ID.
    const cs = agent.chatSessions.get(CHAT_ID);
    expect(cs).toBeDefined();
    expect(cs.pendingSessionId).toBe(legacyId);
    expect(bridge.sendToCC).not.toHaveBeenCalled();
  });
});
