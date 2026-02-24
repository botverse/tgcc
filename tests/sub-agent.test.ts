import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentTracker, isSubAgentTool, type SubAgentSender } from '../src/streaming.js';
import type { StreamInnerEvent } from '../src/cc-protocol.js';

function createMockSubAgentSender() {
  let nextId = 100;
  return {
    replies: [] as Array<{ chatId: number | string; text: string; replyTo: number; messageId: number }>,
    edits: [] as Array<{ chatId: number | string; messageId: number; text: string }>,
    async replyToMessage(chatId: number | string, text: string, replyTo: number, _parseMode?: string): Promise<number> {
      const id = nextId++;
      this.replies.push({ chatId, text, replyTo, messageId: id });
      return id;
    },
    async editMessage(chatId: number | string, messageId: number, text: string, _parseMode?: string): Promise<void> {
      this.edits.push({ chatId, messageId, text });
    },
  };
}

describe('isSubAgentTool', () => {
  it('detects agent-related tools', () => {
    expect(isSubAgentTool('dispatch_agent')).toBe(true);
    expect(isSubAgentTool('Task')).toBe(true);
    expect(isSubAgentTool('create_agent')).toBe(true);
    expect(isSubAgentTool('AgentRunner')).toBe(true);
  });

  it('ignores normal tools', () => {
    expect(isSubAgentTool('Bash')).toBe(false);
    expect(isSubAgentTool('Read')).toBe(false);
    expect(isSubAgentTool('Write')).toBe(false);
    expect(isSubAgentTool('Edit')).toBe(false);
  });
});

describe('SubAgentTracker', () => {
  let sender: ReturnType<typeof createMockSubAgentSender>;
  let tracker: SubAgentTracker;
  let mainMessageId: number | null;

  beforeEach(() => {
    sender = createMockSubAgentSender();
    mainMessageId = 42;
    tracker = new SubAgentTracker({
      chatId: 123,
      sender,
      getMainMessageId: () => mainMessageId,
    });
  });

  it('sends reply when sub-agent tool is detected', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(sender.replies).toHaveLength(1);
    expect(sender.replies[0].text).toContain('<code>dispatch_agent</code>');
    expect(sender.replies[0].text).toContain('🔄');
    expect(sender.replies[0].replyTo).toBe(42);
  });

  it('does NOT send reply for normal tools', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    } as StreamInnerEvent);

    expect(sender.replies).toHaveLength(0);
  });

  it('does NOT send reply when no main message exists', async () => {
    mainMessageId = null;

    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(sender.replies).toHaveLength(0);
  });

  it('marks completed on content_block_stop', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    // Should have edited the reply with completion status
    expect(sender.edits).toHaveLength(1);
    expect(sender.edits[0].text).toContain('✅');
    expect(sender.edits[0].text).toContain('<code>dispatch_agent</code>');
    expect(sender.edits[0].messageId).toBe(100); // the reply message ID
  });

  it('handles multiple concurrent sub-agents', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_2', name: 'Task', input: {} },
    } as StreamInnerEvent);

    expect(sender.replies).toHaveLength(2);
    expect(sender.replies[0].text).toContain('<code>dispatch_agent</code>');
    expect(sender.replies[1].text).toContain('<code>Task</code>');

    expect(tracker.activeAgents).toHaveLength(2);
  });

  it('resets on message_start', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(tracker.activeAgents).toHaveLength(1);

    await tracker.handleEvent({ type: 'message_start' } as StreamInnerEvent);

    expect(tracker.activeAgents).toHaveLength(0);
  });

  it('updates reply with input preview on input_json_delta', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    // Send enough input_json_delta to trigger an update (> 200 chars where length % 200 <= 50)
    const bigChunk = 'x'.repeat(200);
    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: bigChunk },
    } as StreamInnerEvent);

    // The edit should contain the input preview
    const editsForAgent = sender.edits.filter(e => e.messageId === 100);
    expect(editsForAgent.length).toBeGreaterThanOrEqual(1);
    expect(editsForAgent[0].text).toContain('<code>dispatch_agent</code>');
  });

  it('ignores text block events', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    expect(sender.replies).toHaveLength(0);
    expect(tracker.activeAgents).toHaveLength(0);
  });

  it('extracts summary from JSON input on completion', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    // Feed a valid JSON input with a "prompt" field
    const jsonInput = JSON.stringify({ prompt: 'Fix the login bug' });
    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: jsonInput },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    // Last edit should contain the completion with summary
    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('✅');
    expect(lastEdit.text).toContain('Fix the login bug');
    expect(lastEdit.text).toContain('<i>');
  });
});
