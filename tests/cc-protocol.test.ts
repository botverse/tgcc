import { describe, it, expect } from 'vitest';
import {
  createTextMessage,
  createImageMessage,
  createDocumentMessage,
  serializeMessage,
  parseCCOutputLine,
  extractAssistantText,
  extractToolUses,
  isStreamTextDelta,
  isStreamThinkingDelta,
  getStreamBlockType,
  createInitializeRequest,
  type AssistantMessage,
  type InitEvent,
  type ResultEvent,
  type StreamEvent,
  type ControlResponse,
  type ApiErrorEvent,
} from '../src/cc-protocol.js';

describe('cc-protocol input construction', () => {
  it('creates a text message', () => {
    const msg = createTextMessage('hello world');
    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');
    expect(msg.message.content).toBe('hello world');
    expect(msg.uuid).toBeDefined();
    expect(typeof msg.uuid).toBe('string');
  });

  it('creates an image message with base64', () => {
    const msg = createImageMessage('What color is this?', 'abc123base64data', 'image/png');
    expect(msg.type).toBe('user');
    expect(Array.isArray(msg.message.content)).toBe(true);
    const blocks = msg.message.content as Array<{ type: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('text');
    expect(blocks[1].type).toBe('image');
  });

  it('creates a document message', () => {
    const msg = createDocumentMessage('Check this file', '/tmp/tgcc/media/doc.pdf', 'doc.pdf');
    expect(typeof msg.message.content).toBe('string');
    expect(msg.message.content).toContain('/tmp/tgcc/media/doc.pdf');
    expect(msg.message.content).toContain('doc.pdf');
  });

  it('serializes message to JSON', () => {
    const msg = createTextMessage('test');
    const json = serializeMessage(msg);
    const parsed = JSON.parse(json);
    expect(parsed.type).toBe('user');
    expect(parsed.message.content).toBe('test');
  });
});

describe('cc-protocol output parsing', () => {
  it('parses init event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      cwd: '/home/test',
      session_id: 'sess-123',
      tools: ['Bash', 'Read'],
      model: 'claude-opus-4-6',
      uuid: 'uuid-1',
    });
    const event = parseCCOutputLine(line) as InitEvent;
    expect(event).not.toBeNull();
    expect(event.type).toBe('system');
    expect(event.subtype).toBe('init');
    expect(event.session_id).toBe('sess-123');
    expect(event.model).toBe('claude-opus-4-6');
  });

  it('parses assistant message', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        id: 'msg_123',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: null,
        usage: { input_tokens: 3, output_tokens: 7 },
      },
      session_id: 'sess-123',
    });
    const event = parseCCOutputLine(line) as AssistantMessage;
    expect(event).not.toBeNull();
    expect(event.type).toBe('assistant');
    expect(extractAssistantText(event)).toBe('Hello!');
  });

  it('parses assistant message with tool_use blocks', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-4-6',
        id: 'msg_456',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me write a file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/tmp/test.txt', content: 'hello' } },
        ],
        stop_reason: null,
      },
    });
    const event = parseCCOutputLine(line) as AssistantMessage;
    const tools = extractToolUses(event);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Write');
  });

  it('parses result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 2511,
      num_turns: 1,
      result: 'Done.',
      session_id: 'sess-123',
      total_cost_usd: 0.020422,
    });
    const event = parseCCOutputLine(line) as ResultEvent;
    expect(event.type).toBe('result');
    expect(event.subtype).toBe('success');
    expect(event.is_error).toBe(false);
    expect(event.total_cost_usd).toBe(0.020422);
  });

  it('parses error result event', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      result: 'Max turns exceeded',
      session_id: 'sess-123',
    });
    const event = parseCCOutputLine(line) as ResultEvent;
    expect(event.is_error).toBe(true);
    expect(event.subtype).toBe('error_max_turns');
  });

  it('parses tool_result event', () => {
    const line = JSON.stringify({
      type: 'tool_result',
      tool_use_id: 'toolu_1',
      content: 'File written successfully.',
    });
    const event = parseCCOutputLine(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe('tool_result');
  });

  it('parses stream_event with message_start', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: { model: 'claude-opus-4-6', id: 'msg_1', role: 'assistant', content: [], stop_reason: null, usage: {} },
      },
    });
    const event = parseCCOutputLine(line) as StreamEvent;
    expect(event.type).toBe('stream_event');
    expect(event.event.type).toBe('message_start');
  });

  it('parses stream_event with text delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      },
    });
    const event = parseCCOutputLine(line) as StreamEvent;
    expect(isStreamTextDelta(event.event)).toBe(true);
  });

  it('parses stream_event with thinking delta', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think...' },
      },
    });
    const event = parseCCOutputLine(line) as StreamEvent;
    expect(isStreamThinkingDelta(event.event)).toBe(true);
  });

  it('parses stream_event with content_block_start', () => {
    const line = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    });
    const event = parseCCOutputLine(line) as StreamEvent;
    expect(getStreamBlockType(event.event)).toBe('text');
  });

  it('returns null for empty line', () => {
    expect(parseCCOutputLine('')).toBeNull();
    expect(parseCCOutputLine('  ')).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseCCOutputLine('not json')).toBeNull();
  });

  it('returns null for unknown event type', () => {
    expect(parseCCOutputLine('{"type":"unknown_type"}')).toBeNull();
  });

  it('parses system api_error event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_error',
      level: 'error',
      error: { message: 'API overloaded', status: 529 },
      retryInMs: 5000,
      retryAttempt: 1,
      maxRetries: 3,
      timestamp: '2026-02-24T15:00:00.000Z',
    });
    const event = parseCCOutputLine(line) as ApiErrorEvent;
    expect(event).not.toBeNull();
    expect(event.type).toBe('system');
    expect(event.subtype).toBe('api_error');
    expect(event.error.status).toBe(529);
    expect(event.retryAttempt).toBe(1);
  });

  it('parses control_response event', () => {
    const line = JSON.stringify({
      type: 'control_response',
      request_id: 'req-123',
      response: { subtype: 'success' },
    });
    const event = parseCCOutputLine(line) as ControlResponse;
    expect(event).not.toBeNull();
    expect(event.type).toBe('control_response');
    expect(event.request_id).toBe('req-123');
    expect(event.response.subtype).toBe('success');
  });
});

describe('cc-protocol initialize handshake', () => {
  it('creates an initialize control_request', () => {
    const req = createInitializeRequest();
    expect(req.type).toBe('control_request');
    expect(req.request.subtype).toBe('initialize');
    expect(typeof req.request_id).toBe('string');
    expect(req.request_id.length).toBeGreaterThan(0);
  });

  it('generates unique request_ids', () => {
    const req1 = createInitializeRequest();
    const req2 = createInitializeRequest();
    expect(req1.request_id).not.toBe(req2.request_id);
  });
});
