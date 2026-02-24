import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SubAgentTracker, isSubAgentTool, extractAgentLabel, markdownToHtml, type SubAgentSender } from '../src/streaming.js';
import type { StreamInnerEvent } from '../src/cc-protocol.js';

function createMockSubAgentSender() {
  let nextId = 100;
  return {
    sends: [] as Array<{ chatId: number | string; text: string; messageId: number }>,
    edits: [] as Array<{ chatId: number | string; messageId: number; text: string }>,
    async sendMessage(chatId: number | string, text: string, _parseMode?: string): Promise<number> {
      const id = nextId++;
      this.sends.push({ chatId, text, messageId: id });
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

describe('extractAgentLabel', () => {
  it('extracts from explicit name field', () => {
    expect(extractAgentLabel('{"name": "spec-reviewer", "prompt": "Review the spec"}')).toBe('spec-reviewer');
  });

  it('extracts from role field', () => {
    expect(extractAgentLabel('{"role": "code-reviewer", "prompt": "Review code"}')).toBe('code-reviewer');
  });

  it('extracts "You are a [role]" pattern', () => {
    expect(extractAgentLabel('{"prompt": "You are a spec-reviewer. Check all weights."}')).toBe('spec-reviewer');
    expect(extractAgentLabel('{"prompt": "You are the hci-reviewer who validates..."}')).toBe('hci-reviewer');
    expect(extractAgentLabel('{"prompt": "You are an integration-tester that runs..."}')).toBe('integration-tester');
  });

  it('extracts "your role is [role]" pattern', () => {
    expect(extractAgentLabel('{"prompt": "your role is code-reviewer. Do it well."}')).toBe('code-reviewer');
  });

  it('falls back to first 30 chars of prompt', () => {
    const label = extractAgentLabel('{"prompt": "Analyze the authentication middleware for vulnerabilities in the codebase"}');
    expect(label).toBe('Analyze the authentication mid…');
  });

  it('returns empty for no parseable content', () => {
    expect(extractAgentLabel('')).toBe('');
    expect(extractAgentLabel('{}')).toBe('');
  });
});

describe('SubAgentTracker', () => {
  let sender: ReturnType<typeof createMockSubAgentSender>;
  let tracker: SubAgentTracker;

  beforeEach(() => {
    sender = createMockSubAgentSender();
    tracker = new SubAgentTracker({
      chatId: 123,
      sender,
    });
  });

  it('sends standalone message when sub-agent tool is detected (no reply_to)', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0].text).toContain('🔄');
    expect(sender.sends[0].text).toContain('Starting sub-agent');
    // No replyTo property — standalone message
  });

  it('does NOT send message for normal tools', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    } as StreamInnerEvent);

    expect(sender.sends).toHaveLength(0);
  });

  it('marks dispatched (not completed) on content_block_stop', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    // Should show ⏳ dispatched, not ✅ completed
    expect(sender.edits).toHaveLength(1);
    expect(sender.edits[0].text).toContain('⏳');
    expect(sender.edits[0].text).toContain('Working');
    expect(sender.edits[0].text).not.toContain('✅');

    // Status should be dispatched
    const agents = tracker.activeAgents;
    expect(agents[0].status).toBe('dispatched');
  });

  it('marks completed on handleToolResult with result preview', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    // Feed some input to set a label
    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"name": "spec-reviewer", "prompt": "Check weights"}' },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    // Now simulate tool_result
    await tracker.handleToolResult('toolu_1', 'Found 3 discrepancies in weight calculations.');

    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('✅');
    expect(lastEdit.text).toContain('spec-reviewer');
    expect(lastEdit.text).toContain('Found 3 discrepancies');

    expect(tracker.activeAgents[0].status).toBe('completed');
  });

  it('extracts agent label from input and uses it in display', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} },
    } as StreamInnerEvent);

    // Send enough input to extract label and trigger an edit
    const json = '{"prompt": "You are a code-reviewer. Review the authentication middleware and check for security issues in the codebase"}';
    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: json },
    } as StreamInnerEvent);

    // Push past 200 chars to hit throttle window
    const needed = 200 - json.length + 10;
    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: 'x'.repeat(Math.max(needed, 1)) },
    } as StreamInnerEvent);

    // Should use extracted label, not raw tool name "Task"
    const editsForAgent = sender.edits.filter(e => e.messageId === 100);
    expect(editsForAgent.length).toBeGreaterThanOrEqual(1);
    expect(editsForAgent[0].text).toContain('code-reviewer');
    expect(editsForAgent[0].text).not.toContain('Task');
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

    expect(sender.sends).toHaveLength(2);
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

  it('ignores text block events', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as StreamInnerEvent);

    expect(sender.sends).toHaveLength(0);
    expect(tracker.activeAgents).toHaveLength(0);
  });

  it('ignores handleToolResult for unknown toolUseId', async () => {
    await tracker.handleToolResult('unknown_id', 'some result');
    expect(sender.edits).toHaveLength(0);
  });

  it('truncates long tool results to 300 chars', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    const longResult = 'A'.repeat(500);
    await tracker.handleToolResult('toolu_1', longResult);

    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('…');
    // The preview should be ~300 chars + ellipsis, not the full 500
    expect(lastEdit.text.length).toBeLessThan(450);
  });
});

describe('markdownToHtml — table conversion', () => {
  it('converts a simple table to list format', () => {
    const md = `Some text

| Agent | Task |
|---|---|
| spec-reviewer | Verifying weights... |
| hci-reviewer | Verifying sensitivity... |

More text`;

    const html = markdownToHtml(md);
    expect(html).toContain('<b>spec-reviewer</b> — Verifying weights...');
    expect(html).toContain('<b>hci-reviewer</b> — Verifying sensitivity...');
    expect(html).not.toContain('|---|');
  });

  it('converts a three-column table', () => {
    const md = `| Name | Status | Notes |
|---|---|---|
| Alice | Active | Doing well |
| Bob | Idle | On break |`;

    const html = markdownToHtml(md);
    expect(html).toContain('<b>Alice</b> — Active — Doing well');
    expect(html).toContain('<b>Bob</b> — Idle — On break');
  });

  it('leaves non-table pipe characters alone', () => {
    const md = 'Use a | b for logical or';
    const html = markdownToHtml(md);
    expect(html).toContain('Use a | b for logical or');
  });

  it('preserves code blocks containing tables', () => {
    const md = '```\n| a | b |\n|---|---|\n| 1 | 2 |\n```';
    const html = markdownToHtml(md);
    // Should be inside <pre><code>, not converted
    expect(html).toContain('<pre>');
    expect(html).toContain('| a | b |');
  });
});
