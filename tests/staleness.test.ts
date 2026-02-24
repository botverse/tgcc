import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import pino from 'pino';
import { SessionStore, getSessionJsonlPath, computeProjectSlug, summarizeJsonlDelta } from '../src/session.js';

const logger = pino({ level: 'silent' });

// ── getSessionJsonlPath ──

describe('getSessionJsonlPath', () => {
  it('should construct the correct path', () => {
    const path = getSessionJsonlPath('abc-123', '/home/user/project');
    const slug = computeProjectSlug('/home/user/project');
    expect(path).toBe(join(homedir(), '.claude', 'projects', slug, 'abc-123.jsonl'));
  });
});

// ── JSONL tracking in SessionStore ──

describe('SessionStore JSONL tracking', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tgcc-test-'));
    store = new SessionStore(join(tmpDir, 'state.json'), logger);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should store and retrieve JSONL tracking', () => {
    store.updateJsonlTracking('agent1', 'user1', 1234, 9999);
    const tracking = store.getJsonlTracking('agent1', 'user1');
    expect(tracking).toEqual({ size: 1234, mtimeMs: 9999 });
  });

  it('should return undefined when no tracking exists', () => {
    const tracking = store.getJsonlTracking('agent1', 'user1');
    expect(tracking).toBeUndefined();
  });

  it('should clear tracking when clearing session', () => {
    store.setCurrentSession('agent1', 'user1', 'sess-1');
    store.updateJsonlTracking('agent1', 'user1', 500, 1000);
    store.clearSession('agent1', 'user1');

    expect(store.getJsonlTracking('agent1', 'user1')).toBeUndefined();
    expect(store.getUser('agent1', 'user1').currentSessionId).toBeNull();
  });

  it('should clear tracking explicitly', () => {
    store.updateJsonlTracking('agent1', 'user1', 500, 1000);
    store.clearJsonlTracking('agent1', 'user1');
    expect(store.getJsonlTracking('agent1', 'user1')).toBeUndefined();
  });

  it('should persist tracking across store instances', () => {
    const stateFile = join(tmpDir, 'state.json');
    store.updateJsonlTracking('agent1', 'user1', 4096, 12345);

    const store2 = new SessionStore(stateFile, logger);
    expect(store2.getJsonlTracking('agent1', 'user1')).toEqual({ size: 4096, mtimeMs: 12345 });
  });
});

// ── summarizeJsonlDelta ──

describe('summarizeJsonlDelta', () => {
  let tmpDir: string;
  let jsonlPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'tgcc-jsonl-'));
    jsonlPath = join(tmpDir, 'session.jsonl');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEntry(entry: Record<string, unknown>): void {
    appendFileSync(jsonlPath, JSON.stringify(entry) + '\n');
  }

  function makeUserEntry(text: string, uuid?: string): Record<string, unknown> {
    return {
      type: 'user',
      uuid: uuid ?? `user-${Math.random()}`,
      message: { role: 'user', content: text },
    };
  }

  function makeAssistantEntry(text: string, tools?: string[], uuid?: string): Record<string, unknown> {
    const content: Array<Record<string, unknown>> = [];
    if (text) content.push({ type: 'text', text });
    if (tools) {
      for (const name of tools) {
        content.push({ type: 'tool_use', name, id: `tool-${Math.random()}`, input: {} });
      }
    }
    return {
      type: 'assistant',
      uuid: uuid ?? `asst-${Math.random()}`,
      message: { role: 'assistant', content },
    };
  }

  it('should return null when file has not grown', () => {
    writeEntry(makeUserEntry('hello'));
    const size = statSync(jsonlPath).size;
    expect(summarizeJsonlDelta(jsonlPath, size)).toBeNull();
  });

  it('should return null for non-existent file', () => {
    expect(summarizeJsonlDelta('/nonexistent/file.jsonl', 0)).toBeNull();
  });

  it('should summarize a simple user+assistant exchange', () => {
    // Write "old" content
    writeEntry(makeUserEntry('old message'));
    const offset = statSync(jsonlPath).size;

    // Write "new" content (external client)
    writeEntry(makeUserEntry('fix the auth middleware'));
    writeEntry(makeAssistantEntry('Fixed the token validation in auth.ts', ['Read', 'Edit']));

    const summary = summarizeJsonlDelta(jsonlPath, offset);
    expect(summary).not.toBeNull();
    expect(summary).toContain('Session was updated from another client');
    expect(summary).toContain('fix the auth middleware');
    expect(summary).toContain('Read, Edit');
    expect(summary).toContain('Fixed the token validation');
    expect(summary).toContain('Reconnecting');
  });

  it('should handle multiple turns', () => {
    const offset = 0;

    writeEntry(makeUserEntry('fix the auth'));
    writeEntry(makeAssistantEntry('Done fixing auth', ['Edit']));
    writeEntry(makeUserEntry('now run the tests'));
    writeEntry(makeAssistantEntry('All 42 tests pass', ['Bash']));

    const summary = summarizeJsonlDelta(jsonlPath, offset);
    expect(summary).toContain('2 CC turns');
    expect(summary).toContain('fix the auth');
    expect(summary).toContain('run the tests');
    expect(summary).toContain('All 42 tests pass');
  });

  it('should deduplicate assistant messages with same UUID', () => {
    const offset = 0;
    const uuid = 'asst-same';

    writeEntry(makeUserEntry('hello'));
    // CC streams: first partial, then full
    writeEntry(makeAssistantEntry('Thinking...', [], uuid));
    writeEntry(makeAssistantEntry('Here is the full answer with more detail', ['Read'], uuid));

    const summary = summarizeJsonlDelta(jsonlPath, offset);
    expect(summary).toContain('1 CC turn');
    expect(summary).toContain('full answer');
    // Should not contain the partial "Thinking..." as a separate turn
    expect(summary).not.toContain('Thinking...');
  });

  it('should truncate long summaries', () => {
    const offset = 0;

    // Write many turns to exceed 2000 chars
    for (let i = 0; i < 30; i++) {
      writeEntry(makeUserEntry(`Question number ${i}: ${'x'.repeat(50)}`));
      writeEntry(makeAssistantEntry(`Answer number ${i}: ${'y'.repeat(50)}`, ['Read', 'Edit', 'Bash']));
    }

    const summary = summarizeJsonlDelta(jsonlPath, offset, 2000);
    expect(summary).not.toBeNull();
    expect(summary!.length).toBeLessThanOrEqual(2100); // some slack for header
  });

  it('should handle tool-only assistant messages (no text)', () => {
    const offset = 0;
    writeEntry(makeUserEntry('check the file'));
    writeEntry(makeAssistantEntry('', ['Read']));

    const summary = summarizeJsonlDelta(jsonlPath, offset);
    expect(summary).toContain('Used Read');
  });

  it('should skip non-message JSONL lines', () => {
    const offset = 0;
    appendFileSync(jsonlPath, JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }) + '\n');
    writeEntry(makeUserEntry('real message'));
    writeEntry(makeAssistantEntry('real response'));

    const summary = summarizeJsonlDelta(jsonlPath, offset);
    expect(summary).toContain('real message');
    expect(summary).toContain('real response');
  });

  it('should handle user messages with array content', () => {
    const offset = 0;
    appendFileSync(jsonlPath, JSON.stringify({
      type: 'user',
      uuid: 'u1',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this image' },
          { type: 'image', source: { type: 'base64' } },
        ],
      },
    }) + '\n');
    writeEntry(makeAssistantEntry('I see a cat'));

    const summary = summarizeJsonlDelta(jsonlPath, offset);
    expect(summary).toContain('describe this image');
  });
});
