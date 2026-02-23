import { describe, it, expect, vi, beforeEach } from 'vitest';
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

    // Thinking content should NOT appear
    expect(allTexts.every(t => !t.includes('Let me think about this'))).toBe(true);
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
