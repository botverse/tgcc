// tests/session-ownership.test.ts
//
// Regression tests for the "color agent adopted a foreign session" bug:
// ~/.tgcc/state.json's agents.color.sessionsByChat["7016073156"] pointed at
// a6b7eab0-bad4-4672-a1c7-07666173fd7e, a JSONL under
// ~/.claude/projects/-home-fonz-Projects-color/ that was created by an
// unrelated interactive `claude` session, not by the TGCC color agent.
//
// Fix (per tgcc-src, confirmed by reading src/session.ts and src/bridge.ts):
//   1. session.ts exports `isRemoteControlSession(jsonlPath, fileSize?)`,
//      which detects CC's own `"type":"bridge-session"` / `"subtype":"bridge_status"`
//      markers — written only for sessions ever touched by `claude --remote-control`
//      (interactive-with-bridge sessions AND `/newcc` external CC sessions, both of
//      which share external-cc.ts's CC_BASE_ARGS). TGCC's own cc-process.ts never
//      passes --remote-control, so this cleanly tells foreign from TGCC-owned.
//   2. discoverCCSessions() applies this filter in its per-file loop, so every
//      caller (bridge.ts's autoResumeSessions, /sessions, /continue fallback,
//      tgcc_session MCP tool, tgcc_status) is protected without per-call-site
//      changes.
//   3. bridge.ts's autoResumeSessions() no longer discovers-by-mtime for chats
//      with no per-chat tracking; it only trusts agentState.lastSessionId
//      (pre-per-chat-refactor field), and only if that JSONL exists, isn't
//      stale, and isn't remote-control-marked.
//
// This file tests (1) and (2) directly — they're pure, exported, and hermetic.
// (3) lives in a private Bridge method that isn't unit-testable without
// instantiating the full Bridge (which spins up a real grammy Bot + ctl
// sockets) — see the note at the bottom of this file.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverCCSessions,
  isRemoteControlSession,
  computeProjectSlug,
} from '../src/session.js';

let tmpDir: string;
let configDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tgcc-session-ownership-'));
  configDir = join(tmpDir, '.claude');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// The exact repo/session pair from the bug report.
const COLOR_REPO = '/home/fonz/Projects/color';
const COLOR_SLUG = computeProjectSlug(COLOR_REPO);
const FOREIGN_SESSION_ID = 'a6b7eab0-bad4-4672-a1c7-07666173fd7e';

function colorProjectDir(): string {
  return join(configDir, 'projects', COLOR_SLUG);
}

/** A JSONL line CC writes for any session ever touched by `claude --remote-control`
 *  (either `claude --remote-control` directly, or `/remote-control` run inside an
 *  ordinary interactive session) — this is the marker isRemoteControlSession looks for. */
function bridgeSessionMarkerLine(sessionId: string): string {
  return JSON.stringify({ type: 'bridge-session', sessionId, bridgeSessionId: 'cse_abc123', lastSequenceNum: 0 });
}

/** Alternate marker form: a system message with subtype bridge_status. */
function bridgeStatusMarkerLine(): string {
  return JSON.stringify({ type: 'system', subtype: 'bridge_status', message: 'connected' });
}

function realUserLine(text = 'Hello, please help me with something.'): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
}

function assistantLine(): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', model: 'claude-sonnet-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Sure.' }] } });
}

function writeJsonl(dir: string, sessionId: string, lines: string[], mtime?: Date): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  if (mtime) utimesSync(path, mtime, mtime);
  return path;
}

// ── isRemoteControlSession — unit tests ──

describe('isRemoteControlSession', () => {
  it('detects the "type":"bridge-session" marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgcc-rc-'));
    const path = join(dir, 's.jsonl');
    writeFileSync(path, [bridgeSessionMarkerLine('s'), realUserLine(), assistantLine()].join('\n') + '\n');
    expect(isRemoteControlSession(path)).toBe(true);
  });

  it('detects the "subtype":"bridge_status" marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgcc-rc-'));
    const path = join(dir, 's.jsonl');
    writeFileSync(path, [bridgeStatusMarkerLine(), realUserLine(), assistantLine()].join('\n') + '\n');
    expect(isRemoteControlSession(path)).toBe(true);
  });

  it('returns false for an ordinary TGCC session (stream-json, no bridge markers)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgcc-rc-'));
    const path = join(dir, 's.jsonl');
    writeFileSync(path, [realUserLine(), assistantLine()].join('\n') + '\n');
    expect(isRemoteControlSession(path)).toBe(false);
  });

  it('returns false (does not throw) for a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgcc-rc-'));
    const path = join(dir, 'does-not-exist.jsonl');
    expect(() => isRemoteControlSession(path)).not.toThrow();
    expect(isRemoteControlSession(path)).toBe(false);
  });

  it('works without an explicit fileSize (stats the file itself)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tgcc-rc-'));
    const path = join(dir, 's.jsonl');
    writeFileSync(path, [bridgeSessionMarkerLine('s')].join('\n') + '\n');
    expect(isRemoteControlSession(path)).toBe(true); // fileSize omitted
  });
});

// ── discoverCCSessions — the actual bug repro ──

describe('discoverCCSessions — foreign remote-control sessions are never adopted', () => {
  it('excludes a foreign remote-control session even when it is the ONLY and most-recently-modified JSONL in the dir (exact bug repro)', () => {
    // Reproduces the reported state exactly: a6b7eab0-... in
    // ~/.claude/projects/-home-fonz-Projects-color/, created by an unrelated
    // interactive CC session (bridge-session marker), most-recently-modified
    // because it's the only file present.
    writeJsonl(
      colorProjectDir(),
      FOREIGN_SESSION_ID,
      [bridgeSessionMarkerLine(FOREIGN_SESSION_ID), realUserLine('hey, can you look at this bug'), assistantLine()],
      new Date(),
    );

    const found = discoverCCSessions(COLOR_REPO, 10, configDir);
    expect(found).toEqual([]);
  });

  it('excludes the foreign session AND surfaces the legitimate TGCC one, even though the foreign one is newer', () => {
    const ownSessionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeJsonl(
      colorProjectDir(),
      ownSessionId,
      [realUserLine('/start the color rebrand'), assistantLine()],
      new Date(Date.now() - 5 * 60_000), // 5 minutes ago
    );
    writeJsonl(
      colorProjectDir(),
      FOREIGN_SESSION_ID,
      [bridgeSessionMarkerLine(FOREIGN_SESSION_ID), realUserLine('unrelated human chat'), assistantLine()],
      new Date(), // just now — newest by mtime
    );

    const found = discoverCCSessions(COLOR_REPO, 10, configDir);
    expect(found.map(s => s.id)).toEqual([ownSessionId]);
  });

  it('excludes a /newcc-style external CC session (same bridge-session marker, launched via CC_BASE_ARGS --remote-control)', () => {
    // external-cc.ts's ExternalCcManager launches `claude --dangerously-skip-permissions
    // --remote-control -n <name>` in the SAME repo dir as the TGCC agent — its JSONL
    // carries the identical bridge-session marker as any other remote-control session.
    const externalCcSessionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    writeJsonl(
      colorProjectDir(),
      externalCcSessionId,
      [bridgeSessionMarkerLine(externalCcSessionId), realUserLine('working from the phone app'), assistantLine()],
      new Date(),
    );

    expect(discoverCCSessions(COLOR_REPO, 10, configDir)).toEqual([]);
  });

  it('excludes multiple foreign remote-control sessions at once, regardless of marker form (bridge-session vs bridge_status)', () => {
    writeJsonl(
      colorProjectDir(),
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      [bridgeSessionMarkerLine('dddddddd-dddd-4ddd-8ddd-dddddddddddd'), realUserLine('first foreign one'), assistantLine()],
      new Date(Date.now() - 1000),
    );
    writeJsonl(
      colorProjectDir(),
      'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      [bridgeStatusMarkerLine(), realUserLine('second foreign one'), assistantLine()],
      new Date(),
    );

    expect(discoverCCSessions(COLOR_REPO, 10, configDir)).toEqual([]);
  });

  it('mixed realistic directory: agent-*, ralph, sidechain, and remote-control sessions are ALL excluded; only the genuine TGCC session survives', () => {
    const dir = colorProjectDir();
    const ownSessionId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

    // Genuine TGCC session.
    writeJsonl(dir, ownSessionId, [realUserLine('genuine tgcc turn'), assistantLine()], new Date(Date.now() - 2000));
    // Foreign remote-control session (the bug).
    writeJsonl(dir, FOREIGN_SESSION_ID, [bridgeSessionMarkerLine(FOREIGN_SESSION_ID), realUserLine('foreign'), assistantLine()], new Date());
    // Sub-agent transcript.
    writeJsonl(dir, 'agent-11111111-1111-4111-8111-111111111111', [realUserLine('subagent turn'), assistantLine()], new Date());
    // Ralph session.
    writeJsonl(dir, '22222222-2222-4222-8222-222222222222', [realUserLine('You are Ralph, a relentless quality gate.'), assistantLine()], new Date());
    // Sidechain fork.
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '33333333-3333-4333-8333-333333333333.jsonl'),
      [JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'forked subagent transcript' } }), assistantLine()].join('\n') + '\n',
    );

    const found = discoverCCSessions(COLOR_REPO, 10, configDir);
    expect(found.map(s => s.id)).toEqual([ownSessionId]);
  });

  it('does not crash on a corrupt/unreadable JSONL sitting next to a foreign remote-control session', () => {
    const dir = colorProjectDir();
    mkdirSync(dir, { recursive: true });
    // Corrupt file: valid UUID name, garbage content.
    writeFileSync(join(dir, '44444444-4444-4444-8444-444444444444.jsonl'), 'not valid json at all\n{{{');
    writeJsonl(dir, FOREIGN_SESSION_ID, [bridgeSessionMarkerLine(FOREIGN_SESSION_ID), realUserLine(), assistantLine()], new Date());

    expect(() => discoverCCSessions(COLOR_REPO, 10, configDir)).not.toThrow();
    expect(discoverCCSessions(COLOR_REPO, 10, configDir)).toEqual([]);
  });
});

// ── Note on bridge.ts orchestration coverage ──
//
// autoResumeSessions() and the sendToCC resume block (src/bridge.ts) are private
// Bridge methods that consume the primitives tested above (isRemoteControlSession
// via discoverCCSessions, existsSync, getSessionEndState, SessionStore). I read
// both and confirmed:
//   - autoResumeSessions' per-chat loop clears tracking and skips (no crash, no
//     fallback) when a tracked JSONL is missing on disk (bridge.ts ~848-851).
//   - its "no per-chat tracking yet" fallback only trusts agentState.lastSessionId,
//     never directory-mtime discovery, and independently checks existsSync +
//     isRemoteControlSession + staleness before adopting it (bridge.ts ~887-904).
// Bridge itself isn't hermetically instantiable for a unit test — its constructor
// wires a real grammy `Bot` per configured agent once `.start()` runs, requiring a
// live-shaped bot token and touching ctl/mcp sockets. If you want this specific
// orchestration under direct test (not just code review), the seam that would make
// it possible is extracting the per-agent auto-resume decision into a pure function
// (agentState, jsonlExists, isRemoteControlSession, now) -> ResumeDecision, the same
// way buildInboundText was pulled out of Bridge for routing.test.ts.
