import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubAgentTracker, isSubAgentTool, extractAgentLabel, markdownToHtml, parseBackgroundNotifications, type SubAgentSender } from '../src/streaming.js';
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
  it('extracts from explicit name field (highest priority)', () => {
    expect(extractAgentLabel('{"name": "spec-reviewer", "prompt": "Review the spec"}')).toBe('spec-reviewer');
  });

  it('extracts from description field', () => {
    expect(extractAgentLabel('{"description": "Review code quality", "prompt": "Check..."}')).toBe('Review code quality');
  });

  it('extracts from subagent_type field', () => {
    expect(extractAgentLabel('{"subagent_type": "code-reviewer", "prompt": "Review code"}')).toBe('code-reviewer');
  });

  it('extracts from team_name field', () => {
    expect(extractAgentLabel('{"team_name": "review-team", "prompt": "Review all the things"}')).toBe('review-team');
  });

  it('falls back to first line of prompt', () => {
    const label = extractAgentLabel('{"prompt": "Analyze the authentication middleware for vulnerabilities in the codebase"}');
    expect(label).toBe('Analyze the authentication middleware for vulnerabilities in…');
  });

  it('handles partial JSON during streaming (name field complete)', () => {
    expect(extractAgentLabel('{"name": "spec-reviewer", "prompt": "You are')).toBe('spec-reviewer');
  });

  it('handles partial JSON during streaming (description field)', () => {
    expect(extractAgentLabel('{"description": "Verify weights", "prompt": "incomplete')).toBe('Verify weights');
  });

  it('returns empty for no parseable content', () => {
    expect(extractAgentLabel('')).toBe('');
    expect(extractAgentLabel('{}')).toBe('');
  });

  it('prioritizes name over description over subagent_type', () => {
    expect(extractAgentLabel('{"name": "alice", "description": "helper", "subagent_type": "reviewer"}')).toBe('alice');
    expect(extractAgentLabel('{"description": "helper", "subagent_type": "reviewer"}')).toBe('helper');
  });
});

describe('parseBackgroundNotifications', () => {
  it('parses a single notification', () => {
    const xml = `<background_agent_notification>
  <parent_tool_use_id>toolu_abc123</parent_tool_use_id>
  <status>completed</status>
  <result>All tests passed.</result>
</background_agent_notification>`;

    const notifications = parseBackgroundNotifications(xml);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].parentToolUseId).toBe('toolu_abc123');
    expect(notifications[0].status).toBe('completed');
    expect(notifications[0].result).toBe('All tests passed.');
  });

  it('parses multiple notifications', () => {
    const xml = `<background_agent_notification>
  <parent_tool_use_id>toolu_1</parent_tool_use_id>
  <status>completed</status>
</background_agent_notification>
Some text between
<background_agent_notification>
  <parent_tool_use_id>toolu_2</parent_tool_use_id>
  <status>failed</status>
  <result>Build error</result>
</background_agent_notification>`;

    const notifications = parseBackgroundNotifications(xml);
    expect(notifications).toHaveLength(2);
    expect(notifications[0].parentToolUseId).toBe('toolu_1');
    expect(notifications[1].parentToolUseId).toBe('toolu_2');
    expect(notifications[1].status).toBe('failed');
  });

  it('extracts agent_name when present', () => {
    const xml = `<background_agent_notification>
  <parent_tool_use_id>toolu_x</parent_tool_use_id>
  <status>completed</status>
  <agent_name>spec-reviewer</agent_name>
</background_agent_notification>`;

    const notifications = parseBackgroundNotifications(xml);
    expect(notifications[0].agentName).toBe('spec-reviewer');
  });

  it('falls back to name tag for agent name', () => {
    const xml = `<background_agent_notification>
  <parent_tool_use_id>toolu_x</parent_tool_use_id>
  <status>completed</status>
  <name>code-checker</name>
</background_agent_notification>`;

    const notifications = parseBackgroundNotifications(xml);
    expect(notifications[0].agentName).toBe('code-checker');
  });

  it('returns empty for text without notifications', () => {
    expect(parseBackgroundNotifications('Just some regular text')).toHaveLength(0);
    expect(parseBackgroundNotifications('')).toHaveLength(0);
  });

  it('skips malformed notifications (missing required fields)', () => {
    const xml = `<background_agent_notification>
  <status>completed</status>
</background_agent_notification>`;
    expect(parseBackgroundNotifications(xml)).toHaveLength(0);
  });

  it('uses summary tag as fallback for result', () => {
    const xml = `<background_agent_notification>
  <parent_tool_use_id>toolu_x</parent_tool_use_id>
  <status>completed</status>
  <summary>Review complete with 3 findings</summary>
</background_agent_notification>`;

    const notifications = parseBackgroundNotifications(xml);
    expect(notifications[0].result).toBe('Review complete with 3 findings');
  });
});

describe('SubAgentTracker', () => {
  let sender: ReturnType<typeof createMockSubAgentSender>;
  let tracker: SubAgentTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    sender = createMockSubAgentSender();
    tracker = new SubAgentTracker({
      chatId: 123,
      sender,
    });
  });

  afterEach(() => {
    tracker.reset();
    vi.useRealTimers();
  });

  it('sends standalone message when sub-agent tool is detected (no reply_to)', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(sender.sends).toHaveLength(1);
    expect(sender.sends[0].text).toContain('🤖');
    expect(sender.sends[0].text).toContain('Starting sub-agent');
  });

  it('does NOT send message for normal tools', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    } as StreamInnerEvent);

    expect(sender.sends).toHaveLength(0);
  });

  it('marks dispatched on content_block_stop with "Working…" format', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    expect(sender.edits).toHaveLength(1);
    expect(sender.edits[0].text).toContain('🤖');
    expect(sender.edits[0].text).toContain('— Working…');
    expect(sender.edits[0].text).not.toContain('✅');

    const agents = tracker.activeAgents;
    expect(agents[0].status).toBe('dispatched');
  });

  it('shows collapsible blockquote on handleToolResult', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"name": "spec-reviewer", "prompt": "Check weights"}' },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    await tracker.handleToolResult('toolu_1', 'Found 3 discrepancies in weight calculations.');

    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('<blockquote expandable>');
    expect(lastEdit.text).toContain('✅ spec-reviewer');
    expect(lastEdit.text).toContain('Found 3 discrepancies');
    expect(lastEdit.text).toContain('</blockquote>');

    expect(tracker.activeAgents[0].status).toBe('completed');
  });

  it('updates message once label is extracted from input_json_delta', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Task', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"name": "code-reviewer", "prompt": "Review the code"}' },
    } as StreamInnerEvent);

    const labelEdits = sender.edits.filter(e => e.text.includes('code-reviewer'));
    expect(labelEdits.length).toBeGreaterThanOrEqual(1);
    expect(labelEdits[0].text).toContain('🤖 code-reviewer — Working…');
  });

  it('starts elapsed timer on dispatch and updates every 15s', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"name": "spec-reviewer"}' },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    const editsBeforeTimer = sender.edits.length;

    await vi.advanceTimersByTimeAsync(15_000);
    expect(sender.edits.length).toBeGreaterThan(editsBeforeTimer);

    const timerEdit = sender.edits[sender.edits.length - 1];
    expect(timerEdit.text).toContain('🤖 spec-reviewer — Working…');
    expect(timerEdit.text).toMatch(/\(\d+s\)/);

    const editsAfterFirst = sender.edits.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sender.edits.length).toBeGreaterThan(editsAfterFirst);

    const secondTimerEdit = sender.edits[sender.edits.length - 1];
    expect(secondTimerEdit.text).toMatch(/\(30s\)/);
  });

  it('clears elapsed timer on tool_result', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    await tracker.handleToolResult('toolu_1', 'Done!');

    const editsAfterResult = sender.edits.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sender.edits.length).toBe(editsAfterResult);
  });

  it('clears all elapsed timers on reset', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    tracker.reset();

    const editsAfterReset = sender.edits.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sender.edits.length).toBe(editsAfterReset);
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

  it('tracks hadSubAgents correctly', async () => {
    expect(tracker.hadSubAgents).toBe(false);

    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(tracker.hadSubAgents).toBe(true);

    tracker.reset();
    expect(tracker.hadSubAgents).toBe(false);
  });

  it('does NOT reset on message_start (handled by bridge)', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(tracker.activeAgents).toHaveLength(1);

    await tracker.handleEvent({ type: 'message_start' } as StreamInnerEvent);

    expect(tracker.activeAgents).toHaveLength(1);
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

  it('truncates long tool results in collapsible blockquote', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    const longResult = 'A'.repeat(4000);
    await tracker.handleToolResult('toolu_1', longResult);

    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('<blockquote expandable>');
    expect(lastEdit.text).toContain('…');
    expect(lastEdit.text.length).toBeLessThan(3700);
  });
});

describe('SubAgentTracker — auto-backgrounding detection', () => {
  let sender: ReturnType<typeof createMockSubAgentSender>;
  let tracker: SubAgentTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    sender = createMockSubAgentSender();
    tracker = new SubAgentTracker({ chatId: 123, sender });
  });

  afterEach(() => {
    tracker.reset();
    vi.useRealTimers();
  });

  it('detects async_launched status and keeps agent dispatched', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"name": "long-runner"}' },
    } as StreamInnerEvent);

    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    await tracker.handleToolResult('toolu_1', '{"status": "async_launched", "outputFile": "/home/user/.claude/projects/abc/agents/xyz/output.md"}');

    // Should remain dispatched, not completed
    expect(tracker.activeAgents[0].status).toBe('dispatched');
    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('Auto-backgrounded');
    expect(lastEdit.text).toContain('long-runner');
  });

  it('extracts outputFile path from auto-backgrounding result', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    await tracker.handleToolResult('toolu_1', '{"status": "async_launched", "outputFile": "/home/user/.claude/projects/abc/agents/xyz/output.md"}');

    expect(tracker.activeAgents[0].outputFile).toBe('/home/user/.claude/projects/abc/agents/xyz/output.md');
  });

  it('detects spawn confirmations and keeps dispatched', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    await tracker.handleToolResult('toolu_1', 'agent_id: reviewer@team-5\nSpawned successfully');

    expect(tracker.activeAgents[0].status).toBe('dispatched');
    expect(tracker.activeAgents[0].agentName).toBe('reviewer');
    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('Spawned');
  });
});

describe('SubAgentTracker — background notification handling', () => {
  let sender: ReturnType<typeof createMockSubAgentSender>;
  let tracker: SubAgentTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    sender = createMockSubAgentSender();
    tracker = new SubAgentTracker({ chatId: 123, sender });
  });

  afterEach(() => {
    tracker.reset();
    vi.useRealTimers();
  });

  it('matches notification by parent_tool_use_id and marks completed', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_abc', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"name": "spec-reviewer"}' },
    } as StreamInnerEvent);

    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    // Simulate spawn confirmation to keep dispatched
    await tracker.handleToolResult('toolu_abc', 'agent_id: spec-reviewer@team-1\nSpawned successfully');
    expect(tracker.activeAgents[0].status).toBe('dispatched');

    // Now handle background notification
    await tracker.handleBackgroundNotification(`<background_agent_notification>
  <parent_tool_use_id>toolu_abc</parent_tool_use_id>
  <status>completed</status>
  <result>All specs verified successfully.</result>
</background_agent_notification>`);

    expect(tracker.activeAgents[0].status).toBe('completed');
    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('✅');
    expect(lastEdit.text).toContain('spec-reviewer');
    expect(lastEdit.text).toContain('All specs verified');
  });

  it('matches notification by agent name as fallback', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_xyz', name: 'Task', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"name": "code-checker"}' },
    } as StreamInnerEvent);

    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    // Spawn confirmation
    await tracker.handleToolResult('toolu_xyz', 'agent_id: code-checker@team-1\nSpawned successfully');

    // Notification with a DIFFERENT parent_tool_use_id but matching agent_name
    await tracker.handleBackgroundNotification(`<background_agent_notification>
  <parent_tool_use_id>toolu_unknown</parent_tool_use_id>
  <status>completed</status>
  <agent_name>code-checker</agent_name>
  <result>No issues found.</result>
</background_agent_notification>`);

    expect(tracker.activeAgents[0].status).toBe('completed');
  });

  it('handles failed status with error emoji', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    await tracker.handleToolResult('toolu_1', 'agent_id: builder@team\nSpawned successfully');

    await tracker.handleBackgroundNotification(`<background_agent_notification>
  <parent_tool_use_id>toolu_1</parent_tool_use_id>
  <status>failed</status>
  <result>Build failed: missing dependency</result>
</background_agent_notification>`);

    expect(tracker.activeAgents[0].status).toBe('failed');
    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('❌');
  });

  it('fires onAllReported callback when all agents complete via notifications', async () => {
    const callback = vi.fn();
    tracker.setOnAllReported(callback);

    // Set up two agents
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);
    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);
    await tracker.handleToolResult('toolu_1', 'agent_id: a@team\nSpawned successfully');

    await tracker.handleEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_2', name: 'Task', input: {} },
    } as StreamInnerEvent);
    await tracker.handleEvent({ type: 'content_block_stop', index: 1 } as StreamInnerEvent);
    await tracker.handleToolResult('toolu_2', 'agent_id: b@team\nSpawned successfully');

    // First notification — not all complete yet
    await tracker.handleBackgroundNotification(`<background_agent_notification>
  <parent_tool_use_id>toolu_1</parent_tool_use_id>
  <status>completed</status>
</background_agent_notification>`);

    expect(callback).not.toHaveBeenCalled();

    // Second notification — all complete now
    await tracker.handleBackgroundNotification(`<background_agent_notification>
  <parent_tool_use_id>toolu_2</parent_tool_use_id>
  <status>completed</status>
</background_agent_notification>`);

    await vi.advanceTimersByTimeAsync(600);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('ignores notifications for already-completed agents', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    // Complete via tool_result (normal completion)
    await tracker.handleToolResult('toolu_1', 'Done normally.');

    const editsAfterResult = sender.edits.length;

    // Duplicate notification arrives — should be ignored
    await tracker.handleBackgroundNotification(`<background_agent_notification>
  <parent_tool_use_id>toolu_1</parent_tool_use_id>
  <status>completed</status>
</background_agent_notification>`);

    expect(sender.edits.length).toBe(editsAfterResult);
  });

  it('ignores notifications with no matching agent', async () => {
    await tracker.handleBackgroundNotification(`<background_agent_notification>
  <parent_tool_use_id>toolu_nonexistent</parent_tool_use_id>
  <status>completed</status>
</background_agent_notification>`);

    // No agents tracked, no edits
    expect(sender.edits).toHaveLength(0);
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
    expect(html).toContain('<pre>');
    expect(html).toContain('| a | b |');
  });
});
