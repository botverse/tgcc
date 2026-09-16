import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getSessionJsonlPath, computeProjectSlug } from '../src/session.js';

// ── getSessionJsonlPath ──
//
// This file used to also cover SessionStore's JSONL-delta tracking
// (updateJsonlTracking/getJsonlTracking/clearJsonlTracking/setCurrentSession/
// clearSession) and summarizeJsonlDelta's catch-up-summary logic. That whole
// subsystem was stripped in 6e635e0 ("feat: multi-client sessions, session
// discovery from CC JSONL, strip session tracking") — session titles/models
// are now read live from JSONL, and TGCC tracks one session per chat via
// sessionsByChat instead of a manually-tracked "current session" + JSONL
// byte-offset diff. The /catchup command that used to render
// summarizeJsonlDelta's output now just points at /sessions
// (src/bridge.ts, case 'catchup') — confirmed no reimplementation exists
// under another name. tests/session-discovery.test.ts covers the closest
// living survivors (getSessionEndState, getSessionJsonlPath) in more depth;
// this single remaining test is kept as-is per the triage.

describe('getSessionJsonlPath', () => {
  it('should construct the correct path', () => {
    const path = getSessionJsonlPath('abc-123', '/home/user/project');
    const slug = computeProjectSlug('/home/user/project');
    expect(path).toBe(join(homedir(), '.claude', 'projects', slug, 'abc-123.jsonl'));
  });
});
