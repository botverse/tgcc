import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubAgentTracker, isSubAgentTool, extractAgentLabel, markdownToHtml, type SubAgentSender, type MailboxMessage } from '../src/streaming.js';
import type { StreamInnerEvent } from '../src/cc-protocol.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

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
    setReaction: vi.fn(async (_chatId: number | string, _messageId: number, _emoji: string): Promise<void> => {}),
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
  // extractAgentLabel now returns { label, field } — use .label for the string

  it('extracts from explicit name field (highest priority)', () => {
    expect(extractAgentLabel('{"name": "spec-reviewer", "prompt": "Review the spec"}').label).toBe('spec-reviewer');
  });

  it('extracts from description field', () => {
    expect(extractAgentLabel('{"description": "Review code quality", "prompt": "Check..."}').label).toBe('Review code quality');
  });

  it('extracts from subagent_type field', () => {
    expect(extractAgentLabel('{"subagent_type": "code-reviewer", "prompt": "Review code"}').label).toBe('code-reviewer');
  });

  it('extracts from team_name field', () => {
    expect(extractAgentLabel('{"team_name": "review-team", "prompt": "Review all the things"}').label).toBe('review-team');
  });

  it('falls back to first line of prompt', () => {
    const result = extractAgentLabel('{"prompt": "Analyze the authentication middleware for vulnerabilities in the codebase"}');
    expect(result.label).toBe('Analyze the authentication middleware for vulnerabilities in…');
  });

  it('handles partial JSON during streaming (name field complete)', () => {
    expect(extractAgentLabel('{"name": "spec-reviewer", "prompt": "You are').label).toBe('spec-reviewer');
  });

  it('handles partial JSON during streaming (description field)', () => {
    expect(extractAgentLabel('{"description": "Verify weights", "prompt": "incomplete').label).toBe('Verify weights');
  });

  it('returns empty label for no parseable content', () => {
    expect(extractAgentLabel('').label).toBe('');
    expect(extractAgentLabel('{}').label).toBe('');
  });

  it('prioritizes name over description over subagent_type', () => {
    expect(extractAgentLabel('{"name": "alice", "description": "helper", "subagent_type": "reviewer"}').label).toBe('alice');
    expect(extractAgentLabel('{"description": "helper", "subagent_type": "reviewer"}').label).toBe('helper');
  });

  it('returns the correct field name', () => {
    expect(extractAgentLabel('{"name": "alice"}').field).toBe('name');
    expect(extractAgentLabel('{"description": "helper"}').field).toBe('description');
    expect(extractAgentLabel('{}').field).toBeNull();
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
    tracker.reset(); // Clear timers
    vi.useRealTimers();
  });

  it('does NOT send TG messages during turn — StreamAccumulator handles in-turn rendering', async () => {
    // During a turn (inTurn = true), SubAgentTracker only tracks agent metadata.
    // StreamAccumulator renders sub-agent segments inline in the main bubble.
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    // No TG messages sent during turn — tracker just registers the agent
    expect(sender.sends).toHaveLength(0);
    expect(tracker.activeAgents).toHaveLength(1);
    expect(tracker.activeAgents[0].status).toBe('running');
    expect(tracker.hadSubAgents).toBe(true);
  });

  it('does NOT send message for normal tools', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} },
    } as StreamInnerEvent);

    expect(sender.sends).toHaveLength(0);
  });

  it('marks agent as dispatched on content_block_stop (no TG edits during turn)', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_stop',
      index: 0,
    } as StreamInnerEvent);

    // No TG messages or edits during turn
    expect(sender.sends).toHaveLength(0);
    expect(sender.edits).toHaveLength(0);

    // Status should be dispatched
    const agents = tracker.activeAgents;
    expect(agents[0].status).toBe('dispatched');
  });

  it('marks agent completed on handleToolResult without spawn confirmation', async () => {
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

    // Tool result without spawn confirmation → synchronous completion
    await tracker.handleToolResult('toolu_1', 'Found 3 discrepancies in weight calculations.');

    // No TG edits during turn
    expect(sender.edits).toHaveLength(0);
    // Agent is now completed
    expect(tracker.activeAgents[0].status).toBe('completed');
  });

  it('extracts label from input_json_delta (no TG messages during turn)', async () => {
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

    // No TG edits during turn
    expect(sender.edits).toHaveLength(0);
    // Label is extracted into tracker metadata
    const agent = tracker.activeAgents[0];
    expect(agent.label).toBe('code-reviewer');
    expect(agent.agentName).toBe('code-reviewer');
  });

  it('handles multiple concurrent sub-agents (tracking only, no TG messages during turn)', async () => {
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

    // No TG messages during turn
    expect(sender.sends).toHaveLength(0);
    // Both agents are tracked
    expect(tracker.activeAgents).toHaveLength(2);
    expect(tracker.hadSubAgents).toBe(true);
  });

  it('tracks hadSubAgents correctly', async () => {
    expect(tracker.hadSubAgents).toBe(false);

    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    expect(tracker.hadSubAgents).toBe(true);

    // After reset, should be false again
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

    // message_start should NOT reset (bridge handles this now)
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

  it('handleToolResult marks agent completed (no TG edits during turn)', async () => {
    await tracker.handleEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'dispatch_agent', input: {} },
    } as StreamInnerEvent);

    const longResult = 'A'.repeat(4000);
    await tracker.handleToolResult('toolu_1', longResult);

    // No TG edits during turn
    expect(sender.edits).toHaveLength(0);
    // Agent is marked completed
    expect(tracker.activeAgents[0].status).toBe('completed');
  });
});

describe('SubAgentTracker — team name extraction', () => {
  let sender: ReturnType<typeof createMockSubAgentSender>;
  let tracker: SubAgentTracker;

  beforeEach(() => {
    sender = createMockSubAgentSender();
    tracker = new SubAgentTracker({ chatId: 123, sender });
  });

  afterEach(() => {
    tracker.reset();
  });

  it('extracts team name via setTeamName', () => {
    expect(tracker.currentTeamName).toBeNull();
    tracker.setTeamName('kyo-review-5');
    expect(tracker.currentTeamName).toBe('kyo-review-5');
  });

  it('regex extraction from agent_id text', () => {
    const text = 'agent_id: spec-reviewer@kyo-review-5';
    const match = text.match(/agent_id:\s*\S+@(\S+)/);
    expect(match?.[1]).toBe('kyo-review-5');
  });

  it('regex extraction handles various formats', () => {
    const texts = [
      'agent_id: code-reviewer@my-team-123',
      'agent_id:worker@team',
      'agent_id: a@b',
    ];
    for (const t of texts) {
      const m = t.match(/agent_id:\s*\S+@(\S+)/);
      expect(m).not.toBeNull();
    }
  });
});

describe('SubAgentTracker — mailbox watching', () => {
  let sender: ReturnType<typeof createMockSubAgentSender>;
  let tracker: SubAgentTracker;
  let tmpDir: string;
  let mailboxPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    sender = createMockSubAgentSender();
    tracker = new SubAgentTracker({ chatId: 123, sender });

    // Create a temp directory structure for mailbox
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgcc-test-'));
  });

  afterEach(() => {
    tracker.reset();
    vi.useRealTimers();
    // Cleanup temp dir
    try { fs.rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it('startMailboxWatch does nothing without team name', () => {
    tracker.startMailboxWatch();
    expect(tracker.isMailboxWatching).toBe(false);
  });

  it('startMailboxWatch activates with team name set', () => {
    tracker.setTeamName('test-team');
    // Override mailboxPath for testing
    (tracker as any).mailboxPath = path.join(tmpDir, 'team-lead.json');
    tracker.startMailboxWatch();
    expect(tracker.isMailboxWatching).toBe(true);
  });

  it('stopMailboxWatch deactivates', () => {
    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = path.join(tmpDir, 'team-lead.json');
    tracker.startMailboxWatch();
    tracker.stopMailboxWatch();
    expect(tracker.isMailboxWatching).toBe(false);
  });

  it('reset clears team name and stops watching', () => {
    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = path.join(tmpDir, 'team-lead.json');
    tracker.startMailboxWatch();
    tracker.reset();
    expect(tracker.currentTeamName).toBeNull();
    expect(tracker.isMailboxWatching).toBe(false);
  });

  it('findAgentByFrom matches agent labels', async () => {
    // Set up a dispatched agent
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

    // Use the private method via processMailbox
    const matched = (tracker as any).findAgentByFrom('spec-reviewer');
    expect(matched).not.toBeNull();
    expect(matched.label).toBe('spec-reviewer');
  });

  it('processMailbox marks agent completed and reacts on standalone bubble', async () => {
    // Set up a dispatched agent during a turn
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

    // Simulate post-turn: create standalone bubble
    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = path.join(tmpDir, 'team-lead.json');
    await tracker.startPostTurnTracking();
    expect(sender.sends).toHaveLength(1);  // standalone bubble created

    // Write mailbox file
    const mailboxFile = path.join(tmpDir, 'team-lead.json');
    const messages: MailboxMessage[] = [
      {
        from: 'spec-reviewer',
        text: '## Findings Report\n\nAll claims verified.',
        summary: 'Spec review complete',
        timestamp: new Date().toISOString(),
        color: 'green',
        read: false,
      },
    ];
    fs.writeFileSync(mailboxFile, JSON.stringify(messages));

    (tracker as any).lastMailboxCount = 0;
    (tracker as any).processMailbox();

    // Wait for async queue to flush
    await (tracker as any).sendQueue;

    // Agent should be completed
    expect(tracker.activeAgents[0].status).toBe('completed');
    // Reaction set on standalone bubble
    expect(sender.setReaction).toHaveBeenCalledWith(expect.anything(), sender.sends[0].messageId, '👍');
  });

  it('processMailbox calls onAllReported when all agents complete', async () => {
    const reportedCb = vi.fn();
    tracker.setOnAllReported(reportedCb);

    // Set up a dispatched agent
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

    // Write mailbox
    const mailboxFile = path.join(tmpDir, 'team-lead.json');
    fs.writeFileSync(mailboxFile, JSON.stringify([{
      from: 'spec-reviewer',
      text: 'Done',
      summary: 'Complete',
      timestamp: new Date().toISOString(),
      color: 'green',
      read: false,
    }]));

    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = mailboxFile;
    (tracker as any).lastMailboxCount = 0;
    (tracker as any).processMailbox();

    // Callback is deferred by 500ms
    await vi.advanceTimersByTimeAsync(600);
    expect(reportedCb).toHaveBeenCalledOnce();
  });

  it('processMailbox handles multiple agents and messages', async () => {
    // Set up two dispatched agents
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
    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    await tracker.handleEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_2', name: 'Task', input: {} },
    } as StreamInnerEvent);
    await tracker.handleEvent({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"name": "code-reviewer"}' },
    } as StreamInnerEvent);
    await tracker.handleEvent({ type: 'content_block_stop', index: 1 } as StreamInnerEvent);

    // Write mailbox with both results
    const mailboxFile = path.join(tmpDir, 'team-lead.json');
    fs.writeFileSync(mailboxFile, JSON.stringify([
      { from: 'spec-reviewer', text: 'Spec OK', summary: 'Passed', timestamp: new Date().toISOString(), color: 'green', read: false },
      { from: 'code-reviewer', text: 'Code OK', summary: 'Clean', timestamp: new Date().toISOString(), color: 'green', read: false },
    ]));

    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = mailboxFile;
    (tracker as any).lastMailboxCount = 0;
    (tracker as any).processMailbox();

    await (tracker as any).sendQueue;

    const completed = tracker.activeAgents.filter(a => a.status === 'completed');
    expect(completed).toHaveLength(2);
  });

  it('processMailbox ignores unmatched from field', async () => {
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
    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    const mailboxFile = path.join(tmpDir, 'team-lead.json');
    fs.writeFileSync(mailboxFile, JSON.stringify([
      { from: 'unknown-agent', text: 'Hi', summary: 'Mystery', timestamp: new Date().toISOString(), read: false },
    ]));

    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = mailboxFile;
    (tracker as any).lastMailboxCount = 0;
    (tracker as any).processMailbox();

    // Agent should still be dispatched (not completed)
    expect(tracker.activeAgents[0].status).toBe('dispatched');
  });

  it('processMailbox completes agent and edits standalone bubble', async () => {
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
    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    // Set up post-turn standalone bubble
    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = path.join(tmpDir, 'team-lead.json');
    await tracker.startPostTurnTracking();
    expect(sender.sends).toHaveLength(1);

    const mailboxFile = path.join(tmpDir, 'team-lead.json');
    fs.writeFileSync(mailboxFile, JSON.stringify([
      { from: 'spec-reviewer', text: 'Done!', summary: 'Done', timestamp: new Date().toISOString(), color: 'green', read: false },
    ]));

    (tracker as any).lastMailboxCount = 0;
    (tracker as any).processMailbox();

    await (tracker as any).sendQueue;

    // Agent is completed
    expect(tracker.activeAgents[0].status).toBe('completed');
    // Standalone bubble edited with "✅ Done"
    const lastEdit = sender.edits[sender.edits.length - 1];
    expect(lastEdit.text).toContain('✅ Done');
  });

  it('uses color emoji from mailbox message on standalone bubble', async () => {
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
    await tracker.handleEvent({ type: 'content_block_stop', index: 0 } as StreamInnerEvent);

    // Set up post-turn standalone bubble
    tracker.setTeamName('test-team');
    (tracker as any).mailboxPath = path.join(tmpDir, 'team-lead.json');
    await tracker.startPostTurnTracking();
    const standaloneId = sender.sends[0].messageId;

    const mailboxFile = path.join(tmpDir, 'team-lead.json');
    fs.writeFileSync(mailboxFile, JSON.stringify([
      { from: 'spec-reviewer', text: 'Failed!', summary: 'Errors found', timestamp: new Date().toISOString(), color: 'red', read: false },
    ]));

    (tracker as any).lastMailboxCount = 0;
    (tracker as any).processMailbox();

    await (tracker as any).sendQueue;

    // Red color → 👎 reaction on standalone bubble
    expect(sender.setReaction).toHaveBeenCalledWith(
      expect.anything(), standaloneId, '👎'
    );
  });
});

describe('markdownToHtml — table conversion', () => {
  it('converts a simple table to codeBlock format (default mode)', () => {
    const md = `Some text

| Agent | Task |
|---|---|
| spec-reviewer | Verifying weights... |
| hci-reviewer | Verifying sensitivity... |

More text`;

    const html = markdownToHtml(md);
    // Default mode is 'codeBlock' — wraps in <pre><code>
    expect(html).toContain('<pre><code>');
    expect(html).toContain('spec-reviewer');
    expect(html).toContain('hci-reviewer');
    expect(html).not.toContain('|---|');  // separator not in output
  });

  it('converts a three-column table to codeBlock format', () => {
    const md = `| Name | Status | Notes |
|---|---|---|
| Alice | Active | Doing well |
| Bob | Idle | On break |`;

    const html = markdownToHtml(md);
    expect(html).toContain('<pre><code>');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
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
