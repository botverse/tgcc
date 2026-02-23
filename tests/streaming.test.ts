import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamAccumulator, makeMarkdownSafe, splitText, type TelegramSender } from '../src/streaming.js';
import type { StreamInnerEvent } from '../src/cc-protocol.js';

function createMockSender() {
  let nextId = 1;
  return {
    sentMessages: [] as Array<{ chatId: number | string; text: string; messageId: number }>,
    editedMessages: [] as Array<{ chatId: number | string; messageId: number; text: string }>,
    async sendMessage(chatId: number | string, text: string, _parseMode?: string): Promise<number> {
      const id = nextId++;
      this.sentMessages.push({ chatId, text, messageId: id });
      return id;
    },
    async editMessage(chatId: number | string, messageId: number, text: string, _parseMode?: string): Promise<void> {
      this.editedMessages.push({ chatId, messageId, text });
    },
  };
}

describe('makeMarkdownSafe', () => {
  it('closes unclosed triple backticks', () => {
    const result = makeMarkdownSafe('```python\nprint("hi")');
    expect(result).toContain('```');
    const count = (result.match(/```/g) ?? []).length;
    expect(count % 2).toBe(0);
  });

  it('leaves balanced backticks alone', () => {
    const input = '```js\nconsole.log("hi")\n```';
    expect(makeMarkdownSafe(input)).toBe(input);
  });

  it('closes unclosed single backtick', () => {
    const result = makeMarkdownSafe('some `code here');
    expect((result.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('handles empty string', () => {
    expect(makeMarkdownSafe('')).toBe('');
  });
});

describe('splitText', () => {
  it('returns single chunk for short text', () => {
    expect(splitText('hello', 100)).toEqual(['hello']);
  });

  it('splits long text at paragraph breaks', () => {
    const text = 'A'.repeat(3000) + '\n\n' + 'B'.repeat(2000);
    const chunks = splitText(text, 4000);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('\n\n')).toContain('A');
    expect(chunks.join('\n\n')).toContain('B');
  });

  it('handles text with no good break points', () => {
    const text = 'A'.repeat(8000);
    const chunks = splitText(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4000);
  });
});

describe('StreamAccumulator', () => {
  let sender: ReturnType<typeof createMockSender>;
  let acc: StreamAccumulator;

  beforeEach(() => {
    sender = createMockSender();
    acc = new StreamAccumulator({
      chatId: 123,
      sender,
      editIntervalMs: 0, // disable throttle for tests
    });
  });

  it('sends thinking indicator on thinking block start', async () => {
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as StreamInnerEvent);

    expect(sender.sentMessages).toHaveLength(1);
    expect(sender.sentMessages[0].text).toContain('Thinking');
  });

  it('accumulates text deltas and sends first message', async () => {
    // Start text block
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    // Send text delta
    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello world' },
    } as StreamInnerEvent);

    // First text should trigger sendMessage
    expect(sender.sentMessages.length).toBeGreaterThanOrEqual(1);
  });

  it('edits message on subsequent deltas', async () => {
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
    } as StreamInnerEvent);

    // Should have sent once and edited at least once
    expect(sender.sentMessages.length).toBeGreaterThanOrEqual(1);
    // Total communications = sentMessages + editedMessages
    const totalComms = sender.sentMessages.length + sender.editedMessages.length;
    expect(totalComms).toBeGreaterThanOrEqual(2);
  });

  it('finalizes on message_stop', async () => {
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Final text' },
    } as StreamInnerEvent);

    await acc.handleEvent({ type: 'message_stop' } as StreamInnerEvent);

    // The final text should have been sent/edited
    const allTexts = [
      ...sender.sentMessages.map(m => m.text),
      ...sender.editedMessages.map(m => m.text),
    ];
    expect(allTexts.some(t => t.includes('Final text'))).toBe(true);
  });

  it('shows tool use indicator', async () => {
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    } as StreamInnerEvent);

    const allTexts = [
      ...sender.sentMessages.map(m => m.text),
      ...sender.editedMessages.map(m => m.text),
    ];
    expect(allTexts.some(t => t.includes('Bash'))).toBe(true);
  });

  it('ignores thinking delta content', async () => {
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'secret thoughts' } as any,
    } as StreamInnerEvent);

    // None of the sent messages should contain thinking content
    const allTexts = [
      ...sender.sentMessages.map(m => m.text),
      ...sender.editedMessages.map(m => m.text),
    ];
    expect(allTexts.every(t => !t.includes('secret thoughts'))).toBe(true);
  });

  it('tracks all message IDs', async () => {
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hi' },
    } as StreamInnerEvent);

    expect(acc.allMessageIds.length).toBeGreaterThanOrEqual(1);
  });
});
