import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  createTextMessage,
  createImageMessage,
  parseCCOutputLine,
  type StreamEvent,
  type AssistantMessage,
  type ResultEvent,
  type InitEvent,
} from '../src/cc-protocol.js';
import { StreamAccumulator, type TelegramSender } from '../src/streaming.js';
import { validateConfig } from '../src/config.js';
import { SessionStore } from '../src/session.js';
import { hasActiveChildren, CCProcess } from '../src/cc-process.js';
import { mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Integration: simulate CC output → streaming → TG ──

describe('integration: CC stream → TG messages', () => {
  function createMockSender() {
    let nextId = 1;
    return {
      messages: [] as Array<{ type: 'send' | 'edit'; text: string; messageId: number }>,
      async sendMessage(_chatId: number | string, text: string): Promise<number> {
        const id = nextId++;
        this.messages.push({ type: 'send', text, messageId: id });
        return id;
      },
      async editMessage(_chatId: number | string, messageId: number, text: string): Promise<void> {
        this.messages.push({ type: 'edit', text, messageId });
      },
    };
  }

  it('processes a full CC turn with streaming', async () => {
    const sender = createMockSender();
    const acc = new StreamAccumulator({ chatId: 123, sender, editIntervalMs: 0 });

    // Simulate CC NDJSON output sequence
    const events = [
      '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-6","id":"msg_1","role":"assistant","content":[],"stop_reason":null,"usage":{}}}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think about this..."}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello! "}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Here is my response."}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}',
      '{"type":"stream_event","event":{"type":"message_stop"}}',
    ];

    for (const line of events) {
      const parsed = parseCCOutputLine(line) as StreamEvent;
      expect(parsed).not.toBeNull();
      await acc.handleEvent(parsed.event);
    }

    // Verify thinking indicator was shown
    const thinkingMsgs = sender.messages.filter(m => m.text.includes('Thinking'));
    expect(thinkingMsgs.length).toBeGreaterThanOrEqual(1);

    // Verify final text was sent
    const allTexts = sender.messages.map(m => m.text);
    expect(allTexts.some(t => t.includes('Hello!'))).toBe(true);
    expect(allTexts.some(t => t.includes('Here is my response.'))).toBe(true);

    // Thinking content should now appear inside an expandable blockquote
    const hasThinkingBlockquote = allTexts.some(t =>
      t.includes('blockquote expandable') && t.includes('Let me think about this')
    );
    expect(hasThinkingBlockquote).toBe(true);
  });

  it('processes a turn with tool use', async () => {
    const sender = createMockSender();
    const acc = new StreamAccumulator({ chatId: 456, sender, editIntervalMs: 0 });

    const events = [
      '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-6","id":"msg_2","role":"assistant","content":[],"stop_reason":null,"usage":{}}}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}',
      '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me read that file."}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":0}}',
      '{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"Read","input":{}}}}',
      '{"type":"stream_event","event":{"type":"content_block_stop","index":1}}',
      '{"type":"stream_event","event":{"type":"message_stop"}}',
    ];

    for (const line of events) {
      const parsed = parseCCOutputLine(line) as StreamEvent;
      await acc.handleEvent(parsed.event);
    }

    const allTexts = sender.messages.map(m => m.text);
    expect(allTexts.some(t => t.includes('Let me read that file'))).toBe(true);
    expect(allTexts.some(t => t.includes('Read'))).toBe(true);
  });
});

describe('integration: config → session store', () => {
  const testDir = join(tmpdir(), `tgcc-test-${Date.now()}`);
  const stateFile = join(testDir, 'state.json');

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  it('persists and loads session state', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-abc');
    store.updateSessionActivity('personal', '123', 0.05);
    store.setModel('personal', '123', 'claude-opus-4-6');
    store.setRepo('personal', '123', '/home/test/project');

    // Create new store instance (simulates restart)
    const store2 = new SessionStore(stateFile, logger);
    const user = store2.getUser('personal', '123');

    expect(user.currentSessionId).toBe('sess-abc');
    expect(user.model).toBe('claude-opus-4-6');
    expect(user.repo).toBe('/home/test/project');
    expect(user.knownSessionIds).toContain('sess-abc');
  });

  it('tracks multiple sessions', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-1');
    store.updateSessionActivity('personal', '123');
    store.setCurrentSession('personal', '123', 'sess-2');
    store.updateSessionActivity('personal', '123');

    const sessions = store.getRecentSessions('personal', '123');
    expect(sessions).toHaveLength(2);
  });

  it('clears session on /new', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-abc');
    store.clearSession('personal', '123');

    const user = store.getUser('personal', '123');
    expect(user.currentSessionId).toBeNull();
  });
});

describe('integration: session titles and deletion', () => {
  const testDir = join(tmpdir(), `tgcc-test-title-${Date.now()}`);
  const stateFile = join(testDir, 'state.json');

  beforeEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true });
    mkdirSync(testDir, { recursive: true });
  });

  it('sets session title (truncated to 40 chars)', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-title');
    store.setSessionTitle('personal', '123', 'sess-title', 'Fix auth middleware for JWT tokens');

    const sessions = store.getRecentSessions('personal', '123');
    expect(sessions[0].title).toBe('Fix auth middleware for JWT tokens');
  });

  it('truncates long titles to 40 chars', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-long');
    store.setSessionTitle('personal', '123', 'sess-long', 'A'.repeat(60));

    const sessions = store.getRecentSessions('personal', '123');
    expect(sessions[0].title).toBe('A'.repeat(40));
  });

  it('does not overwrite existing title', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-keep');
    store.setSessionTitle('personal', '123', 'sess-keep', 'First title');
    store.setSessionTitle('personal', '123', 'sess-keep', 'Second title');

    const sessions = store.getRecentSessions('personal', '123');
    expect(sessions[0].title).toBe('First title');
  });

  it('deletes a session', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-del-1');
    store.setCurrentSession('personal', '123', 'sess-del-2');

    const deleted = store.deleteSession('personal', '123', 'sess-del-1');
    expect(deleted).toBe(true);

    const sessions = store.getRecentSessions('personal', '123');
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('sess-del-2');
  });

  it('clears currentSessionId when deleting the active session', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    store.setCurrentSession('personal', '123', 'sess-active');
    const deleted = store.deleteSession('personal', '123', 'sess-active');
    expect(deleted).toBe(true);

    const user = store.getUser('personal', '123');
    expect(user.currentSessionId).toBeNull();
  });

  it('returns false when deleting non-existent session', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    const store = new SessionStore(stateFile, logger);

    const deleted = store.deleteSession('personal', '123', 'nonexistent');
    expect(deleted).toBe(false);
  });
});

describe('integration: CC activity state tracking', () => {
  it('tracks activity state through stream events', () => {
    // Parse events and verify state transitions that CCProcess would make
    const messageStart = parseCCOutputLine(
      '{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-6","id":"msg_1","role":"assistant","content":[],"stop_reason":null,"usage":{}}}}'
    );
    expect(messageStart).not.toBeNull();
    expect(messageStart!.type).toBe('stream_event');

    // Assistant message with tool_use stop_reason
    const assistantToolUse = parseCCOutputLine(
      '{"type":"assistant","message":{"model":"claude-opus-4-6","id":"msg_1","role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],"stop_reason":"tool_use"}}'
    );
    expect(assistantToolUse).not.toBeNull();
    expect(assistantToolUse!.type).toBe('assistant');
    expect((assistantToolUse as AssistantMessage).message.stop_reason).toBe('tool_use');

    // Tool result
    const toolResult = parseCCOutputLine('{"type":"tool_result","tool_use_id":"t1","content":"file contents"}');
    expect(toolResult).not.toBeNull();
    expect(toolResult!.type).toBe('tool_result');

    // Result event
    const result = parseCCOutputLine('{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.05}');
    expect(result).not.toBeNull();
    expect(result!.type).toBe('result');
  });
});

describe('integration: hasActiveChildren', () => {
  it('returns false for undefined pid', () => {
    expect(hasActiveChildren(undefined)).toBe(false);
  });

  it('returns false for non-existent pid', () => {
    // Use a very high PID that almost certainly doesn't exist
    expect(hasActiveChildren(999999999)).toBe(false);
  });
});

describe('integration: full message construction', () => {
  it('constructs text message and parses back', () => {
    const msg = createTextMessage('Hello CC');
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('user');
    expect(parsed.message.content).toBe('Hello CC');
  });

  it('constructs image message with correct structure', () => {
    const msg = createImageMessage('Describe this', 'base64data', 'image/png');
    const blocks = msg.message.content as Array<Record<string, any>>;
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].text).toBe('Describe this');
    expect(blocks[1].type).toBe('image');
    expect(blocks[1].source.type).toBe('base64');
    expect(blocks[1].source.media_type).toBe('image/png');
    expect(blocks[1].source.data).toBe('base64data');
  });
});

describe('integration: session takeover detection', () => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;

  it('emits takeover event on unexpected exit (non-zero code)', async () => {
    // Spawn a process that exits with code 1 (simulating external kill)
    const proc = new CCProcess({
      agentId: 'test',
      userId: '123',
      ccBinaryPath: 'bash',
      userConfig: {
        model: 'claude-opus-4-6',
        repo: '/tmp',
        maxTurns: 1,
        idleTimeoutMs: 300_000,
        hangTimeoutMs: 300_000,
        permissionMode: 'dangerously-skip',
      },
      continueSession: false,
      logger: mockLogger,
    });

    // Override buildArgs to make the process exit with code 1
    (proc as any).buildArgs = () => ['-c', 'exit 1'];
    // Skip the initialize request (bash won't handle it)
    (proc as any).sendInitializeRequest = () => {};

    const takeover = vi.fn();
    proc.on('takeover', takeover);

    await proc.start();
    // Wait for the process to exit
    await new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
    });

    expect(takeover).toHaveBeenCalled();
    expect(proc.takenOver).toBe(true);
  });

  it('does NOT emit takeover when killed by us', async () => {
    const proc = new CCProcess({
      agentId: 'test',
      userId: '123',
      ccBinaryPath: 'bash',
      userConfig: {
        model: 'claude-opus-4-6',
        repo: '/tmp',
        maxTurns: 1,
        idleTimeoutMs: 300_000,
        hangTimeoutMs: 300_000,
        permissionMode: 'dangerously-skip',
      },
      continueSession: false,
      logger: mockLogger,
    });

    // Override to make it sleep (so we can kill it ourselves)
    (proc as any).buildArgs = () => ['-c', 'sleep 60'];
    (proc as any).sendInitializeRequest = () => {};

    const takeover = vi.fn();
    proc.on('takeover', takeover);

    await proc.start();
    // Give it a moment to start
    await new Promise(r => setTimeout(r, 100));

    // Kill it ourselves
    proc.kill();

    await new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
    });

    expect(takeover).not.toHaveBeenCalled();
    expect(proc.takenOver).toBe(false);
  });

  it('does NOT emit takeover on clean exit (code 0)', async () => {
    const proc = new CCProcess({
      agentId: 'test',
      userId: '123',
      ccBinaryPath: 'bash',
      userConfig: {
        model: 'claude-opus-4-6',
        repo: '/tmp',
        maxTurns: 1,
        idleTimeoutMs: 300_000,
        hangTimeoutMs: 300_000,
        permissionMode: 'dangerously-skip',
      },
      continueSession: false,
      logger: mockLogger,
    });

    (proc as any).buildArgs = () => ['-c', 'exit 0'];
    (proc as any).sendInitializeRequest = () => {};

    const takeover = vi.fn();
    proc.on('takeover', takeover);

    await proc.start();
    await new Promise<void>((resolve) => {
      proc.on('exit', () => resolve());
    });

    expect(takeover).not.toHaveBeenCalled();
    expect(proc.takenOver).toBe(false);
  });
});
