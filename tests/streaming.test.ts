import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StreamAccumulator, makeMarkdownSafe, makeHtmlSafe, escapeHtml, markdownToHtml, splitText, type TelegramSender } from '../src/streaming.js';
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

describe('escapeHtml', () => {
  it('escapes angle brackets and ampersand', () => {
    expect(escapeHtml('<b>test</b> & "quotes"')).toBe('&lt;b&gt;test&lt;/b&gt; &amp; "quotes"');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('markdownToHtml', () => {
  it('converts code blocks with language', () => {
    const result = markdownToHtml('```python\nprint("hi")\n```');
    expect(result).toContain('<pre><code class="language-python">');
    expect(result).toContain('print("hi")');
  });

  it('converts inline code', () => {
    const result = markdownToHtml('use `npm install` here');
    expect(result).toContain('<code>npm install</code>');
  });

  it('converts bold text', () => {
    expect(markdownToHtml('**hello**')).toContain('<b>hello</b>');
  });

  it('converts italic text', () => {
    expect(markdownToHtml('*hello*')).toContain('<i>hello</i>');
  });

  it('converts strikethrough text', () => {
    expect(markdownToHtml('~~deleted~~')).toContain('<s>deleted</s>');
  });

  it('converts links', () => {
    const result = markdownToHtml('[Google](https://google.com)');
    expect(result).toContain('<a href="https://google.com">Google</a>');
  });

  it('escapes HTML in non-code text', () => {
    const result = markdownToHtml('use <div> tag');
    expect(result).toContain('&lt;div&gt;');
  });

  it('handles empty string', () => {
    expect(markdownToHtml('')).toBe('');
  });
});

describe('makeMarkdownSafe (deprecated, now HTML)', () => {
  it('returns HTML-converted text', () => {
    const result = makeMarkdownSafe('**bold** and `code`');
    expect(result).toContain('<b>bold</b>');
    expect(result).toContain('<code>code</code>');
  });
});

describe('splitText', () => {
  it('returns single chunk for short text', () => {
    expect(splitText('hello', 100)).toEqual(['hello']);
  });

  it('splits long text at paragraph breaks', () => {
    const text = 'A'.repeat(3000) + '\n\n' + 'B'.repeat(2000);
    const chunks = splitText(text, 3500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.join('\n\n')).toContain('A');
    expect(chunks.join('\n\n')).toContain('B');
  });

  it('handles text with no good break points', () => {
    const text = 'A'.repeat(8000);
    const chunks = splitText(text, 3500);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].length).toBe(3500);
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
    expect(sender.sentMessages[0].text).toContain('💭 Processing...');
    expect(sender.sentMessages[0].text).toContain('blockquote');
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

  it('accumulates thinking content for expandable blockquote', async () => {
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'analyzing the problem' } as any,
    } as StreamInnerEvent);

    // Thinking indicator should show but not the thinking content yet (no text block yet)
    expect(sender.sentMessages).toHaveLength(1);
    expect(sender.sentMessages[0].text).toContain('💭 Processing...');

    // End thinking block, start text block
    await acc.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'Here is the answer' },
    } as StreamInnerEvent);

    await acc.handleEvent({ type: 'message_stop' } as StreamInnerEvent);

    // Thinking gets its own message (edited from "Processing..." to actual content);
    // text response goes in a separate message
    const allTexts = [
      ...sender.sentMessages.map(m => m.text),
      ...sender.editedMessages.map(m => m.text),
    ];
    // Thinking content should appear in an edit (the early flush or finalize edit)
    expect(allTexts.some(t => t.includes('analyzing the problem'))).toBe(true);
    // Text content should appear in a sent or edited message
    expect(allTexts.some(t => t.includes('Here is the answer'))).toBe(true);
    // Thinking message should use expandable blockquote
    expect(allTexts.some(t => t.includes('blockquote expandable'))).toBe(true);
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

  it('serializes concurrent sendOrEdit calls via mutex (no duplicate messages)', async () => {
    // Simulate a slow sendMessage to expose the race condition
    let sendCount = 0;
    let editCount = 0;
    const slowSender: TelegramSender = {
      async sendMessage(_chatId, _text, _parseMode) {
        sendCount++;
        // Simulate async delay (network latency)
        await new Promise<void>(r => setTimeout(r, 50));
        return 1;
      },
      async editMessage() {
        editCount++;
      },
    };

    const slowAcc = new StreamAccumulator({
      chatId: 123,
      sender: slowSender,
      editIntervalMs: 0,
    });

    // Start text block
    await slowAcc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    // Fire two deltas rapidly WITHOUT awaiting (simulates sync event dispatch from bridge)
    const p1 = slowAcc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello' },
    } as StreamInnerEvent);

    // Don't await p1 — fire second delta immediately while first is in-flight
    const p2 = slowAcc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: ' world' },
    } as StreamInnerEvent);

    await Promise.all([p1, p2]);

    // With the mutex, only ONE sendMessage call should have been made
    // The second delta should have been serialized and used editMessage instead
    expect(sendCount).toBe(1);
    expect(editCount).toBeGreaterThanOrEqual(1);
  });

  it('softReset keeps tgMessageId for multi-turn editing', async () => {
    // First turn: send a message
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Turn 1' },
    } as StreamInnerEvent);

    await acc.finalize();

    expect(sender.sentMessages).toHaveLength(1);
    const firstMsgId = sender.sentMessages[0].messageId;

    // Simulate new turn: message_start triggers softReset
    await acc.handleEvent({ type: 'message_start' } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Turn 2' },
    } as StreamInnerEvent);

    // Should NOT have sent a new message — should have edited the existing one
    expect(sender.sentMessages).toHaveLength(1);
    expect(sender.editedMessages.length).toBeGreaterThanOrEqual(1);
    // The edit should target the same message ID
    const lastEdit = sender.editedMessages[sender.editedMessages.length - 1];
    expect(lastEdit.messageId).toBe(firstMsgId);
    expect(lastEdit.text).toContain('Turn 2');
  });

  it('full reset clears tgMessageId (new message on next send)', async () => {
    // Send a message
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'First' },
    } as StreamInnerEvent);

    expect(sender.sentMessages).toHaveLength(1);

    // Full reset (simulates process exit)
    acc.reset();

    // Next turn should create a new message
    await acc.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    await acc.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Second' },
    } as StreamInnerEvent);

    expect(sender.sentMessages).toHaveLength(2);
  });
});
