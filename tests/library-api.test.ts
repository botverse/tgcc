import { describe, it, expect, vi } from 'vitest';

// Test importing from the library entry point
import {
  // Process
  CCProcess,
  hasActiveChildren,
  generateMcpConfig,
  // Protocol - functions
  parseCCOutputLine,
  createInitializeRequest,
  createPermissionResponse,
  createTextMessage,
  createImageMessage,
  createDocumentMessage,
  serializeMessage,
  extractAssistantText,
  extractToolUses,
  isStreamTextDelta,
  isStreamThinkingDelta,
  getStreamBlockType,
  // Session
  SessionStore,
  getSessionJsonlPath,
  computeProjectSlug,
  // Streaming
  StreamAccumulator,
  SubAgentTracker,
  markdownToHtml,
  makeHtmlSafe,
  escapeHtml,
  formatUsageFooter,
  splitText,
  isSubAgentTool,
} from '../src/index.js';

import type {
  CCProcessOptions,
  CCUserConfig,
  ProcessState,
  CCOutputEvent,
  UserMessage,
  AssistantMessage,
  StreamInnerEvent,
  StreamTextDelta,
  StreamThinkingDelta,
  StreamContentBlockStart,
  PermissionRequest,
  ControlResponse,
  ResultEvent,
  TelegramSender,
  StreamAccumulatorOptions,
  SubAgentSender,
  SubAgentTrackerOptions,
  SessionInfo,
} from '../src/index.js';

describe('Library API - exports', () => {
  it('exports CCProcess class', () => {
    expect(CCProcess).toBeDefined();
    expect(typeof CCProcess).toBe('function');
  });

  it('exports protocol functions', () => {
    expect(typeof parseCCOutputLine).toBe('function');
    expect(typeof createInitializeRequest).toBe('function');
    expect(typeof createTextMessage).toBe('function');
    expect(typeof extractAssistantText).toBe('function');
    expect(typeof extractToolUses).toBe('function');
    expect(typeof isStreamTextDelta).toBe('function');
    expect(typeof isStreamThinkingDelta).toBe('function');
    expect(typeof getStreamBlockType).toBe('function');
  });

  it('exports session utilities', () => {
    expect(typeof SessionStore).toBe('function');
    expect(typeof getSessionJsonlPath).toBe('function');
    expect(typeof computeProjectSlug).toBe('function');
  });

  it('exports streaming utilities', () => {
    expect(typeof StreamAccumulator).toBe('function');
    expect(typeof SubAgentTracker).toBe('function');
    expect(typeof markdownToHtml).toBe('function');
    expect(typeof makeHtmlSafe).toBe('function');
    expect(typeof escapeHtml).toBe('function');
    expect(typeof splitText).toBe('function');
    expect(typeof isSubAgentTool).toBe('function');
  });
});

describe('Library API - CCProcess construction', () => {
  it('can be constructed with just options (no config file)', () => {
    const userConfig: CCUserConfig = {
      model: 'claude-sonnet-4-20250514',
      repo: '/tmp/test-repo',
      maxTurns: 10,
      idleTimeoutMs: 300_000,
      hangTimeoutMs: 600_000,
      permissionMode: 'default',
    };

    const options: CCProcessOptions = {
      agentId: 'test-agent',
      userId: 'test-user',
      ccBinaryPath: '/usr/bin/claude',
      userConfig,
      continueSession: false,
      // logger omitted — should use noop logger
    };

    const proc = new CCProcess(options);
    expect(proc).toBeInstanceOf(CCProcess);
    expect(proc.agentId).toBe('test-agent');
    expect(proc.userId).toBe('test-user');
    expect(proc.state).toBe('idle');
    expect(proc.sessionId).toBeNull();
    expect(proc.totalCostUsd).toBe(0);
    expect(proc.spawnedAt).toBeNull();
    expect(proc.pid).toBeUndefined();

    proc.destroy();
  });

  it('accepts an optional logger', () => {
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    const options: CCProcessOptions = {
      agentId: 'test',
      userId: 'user',
      ccBinaryPath: '/usr/bin/claude',
      userConfig: {
        model: 'claude-sonnet-4-20250514',
        repo: '/tmp/test',
        maxTurns: 5,
        idleTimeoutMs: 60_000,
        hangTimeoutMs: 120_000,
        permissionMode: 'dangerously-skip',
      },
      continueSession: false,
      logger: mockLogger as any,
    };

    const proc = new CCProcess(options);
    expect(mockLogger.child).toHaveBeenCalledWith({ agentId: 'test', userId: 'user' });
    proc.destroy();
  });
});

describe('Library API - StreamAccumulator with custom callbacks', () => {
  it('works with a custom sender (no Telegram dependency)', async () => {
    const sent: { text: string; parseMode?: string }[] = [];
    const edited: { id: number; text: string }[] = [];

    const sender: TelegramSender = {
      sendMessage: async (_chatId, text, parseMode) => {
        sent.push({ text, parseMode });
        return sent.length; // mock message ID
      },
      editMessage: async (_chatId, messageId, text) => {
        edited.push({ id: messageId, text });
      },
    };

    const options: StreamAccumulatorOptions = {
      chatId: 123,
      sender,
      editIntervalMs: 0, // no throttle for tests
    };

    const acc = new StreamAccumulator(options);

    // Simulate a stream: message_start → content_block_start(text) → deltas → stop
    await acc.handleEvent({ type: 'message_start', message: { model: 'test', id: 'msg1', role: 'assistant', content: [], stop_reason: null, usage: {} } });
    await acc.handleEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } as any);
    await acc.handleEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } } as any);
    await acc.handleEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } } as any);
    await acc.handleEvent({ type: 'content_block_stop', index: 0 });
    await acc.handleEvent({ type: 'message_stop' });

    // Should have sent or edited messages
    expect(sent.length).toBeGreaterThan(0);
    // The final text should contain "Hello world!"
    const allTexts = [...sent.map(s => s.text), ...edited.map(e => e.text)];
    const finalText = allTexts[allTexts.length - 1];
    expect(finalText).toContain('Hello world!');
  });
});

describe('Library API - SubAgentTracker with custom callbacks', () => {
  it('works with a custom sender', async () => {
    const replies: { text: string; replyTo: number }[] = [];
    const edits: { id: number; text: string }[] = [];

    const sender: SubAgentSender = {
      replyToMessage: async (_chatId, text, replyToMessageId) => {
        replies.push({ text, replyTo: replyToMessageId });
        return replies.length + 100; // mock message ID
      },
      editMessage: async (_chatId, messageId, text) => {
        edits.push({ id: messageId, text });
      },
    };

    const options: SubAgentTrackerOptions = {
      chatId: 456,
      sender,
      getMainMessageId: () => 42,
    };

    const tracker = new SubAgentTracker(options);

    // Simulate a sub-agent tool_use block
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'tu_1', name: 'dispatch_agent', input: {} },
    } as any);

    // Should have sent a reply
    expect(replies.length).toBe(1);
    expect(replies[0].text).toContain('Sub-agent spawned');
    expect(replies[0].replyTo).toBe(42);
  });
});

describe('Library API - Protocol helpers work standalone', () => {
  it('createTextMessage creates a valid UserMessage', () => {
    const msg = createTextMessage('test prompt');
    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');
    expect(msg.message.content).toBe('test prompt');
    expect(msg.uuid).toBeDefined();
  });

  it('parseCCOutputLine parses events', () => {
    const event = parseCCOutputLine(JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.05,
    }));
    expect(event).not.toBeNull();
    expect(event!.type).toBe('result');
  });

  it('markdownToHtml converts basic markdown', () => {
    const html = markdownToHtml('**bold** and *italic*');
    expect(html).toContain('<b>bold</b>');
    expect(html).toContain('<i>italic</i>');
  });

  it('escapeHtml escapes special characters', () => {
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });
});
