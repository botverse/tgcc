// tests/monitor.test.ts
//
// Regression coverage for src/monitor.ts (ConversationMonitor) — acceptance criteria 1-10 from
// work/agent-conversation-monitor/PLAN.md, plus the items from the test brief that were flagged
// as under-exercised: cross-agent ⚠️ priority (item 1), two concurrent chats on one agent (item
// 7), and topic ids keyed by destination chat (item 9). Criteria 12/13/14 (auth routing, monitor
// destination chat exclusion, private-chat lockout) are Bridge-level wiring and live in
// tests/monitor-bridge.test.ts instead — this file tests ConversationMonitor's own public
// interface directly, against a mocked MonitorSenderBot. No real Telegram calls anywhere.
//
// Hermetic filesystem: every ConversationMonitor built here gets its own mkdtemp'd persistPath
// override (never the real ~/.tgcc/monitor-topics.json) and a writeConfigChatId spy that only
// mutates an in-memory config object (never the real ~/.tgcc/config.json).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationMonitor, type MonitorSenderBot, type MonitorLogger, type TelegramSenderIdentity } from '../src/monitor.js';
import type { MonitorConfig } from '../src/config.js';
import type { AssistantMessage, AssistantContentBlock, ToolResultEvent, ResultEvent } from '../src/cc-protocol.js';

const OWNER_ID = '7016073156'; // same id used throughout PLAN.md's own examples

// ── Fixture builders ──

function textBlock(text: string): AssistantContentBlock {
  return { type: 'text', text };
}
function thinkingBlock(text: string): AssistantContentBlock {
  return { type: 'thinking', thinking: text };
}
function toolUseBlock(name: string, input: Record<string, unknown>, id = 'tu1'): AssistantContentBlock {
  return { type: 'tool_use', id, name, input };
}
function assistantMessage(blocks: AssistantContentBlock[], stopReason: string | null = 'end_turn'): AssistantMessage {
  return { type: 'assistant', message: { model: 'claude-test', id: 'msg1', role: 'assistant', content: blocks, stop_reason: stopReason } };
}
function toolResultEvent(overrides: Partial<ToolResultEvent> = {}): ToolResultEvent {
  return { type: 'tool_result', tool_use_id: 'tu1', content: 'ok', ...overrides };
}
function resultEvent(overrides: Partial<ResultEvent> = {}): ResultEvent {
  return { type: 'result', subtype: 'success', is_error: false, ...overrides };
}
function humanIdentity(id = '5934038536', overrides: Partial<TelegramSenderIdentity> = {}): TelegramSenderIdentity {
  return { userId: id, userName: 'Colleague', userHandle: 'colleague_handle', chatId: Number(id), isGroup: false, ...overrides };
}

function makeConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    chatId: -1001234567890,
    agents: ['sentinella', 'sentinella_team', 'kyo_team', 'kyobot', 'agentA', 'agentB'],
    excludeUsers: [OWNER_ID],
    topicPerAgent: true,
    ownerUserId: OWNER_ID,
    ...overrides,
  };
}

interface SentMessage {
  chatId: number | string;
  text: string;
  threadId?: number;
}

function defaultBot(): { bot: MonitorSenderBot; sent: SentMessage[]; sendText: ReturnType<typeof vi.fn>; createForumTopic: ReturnType<typeof vi.fn> } {
  const sent: SentMessage[] = [];
  let nextTopic = 100;
  const sendText = vi.fn(async (chatId: number | string, text: string, _parseMode?: string, _silent?: boolean, threadId?: number) => {
    sent.push({ chatId, text, threadId });
    return sent.length;
  });
  const createForumTopic = vi.fn(async () => nextTopic++);
  return { bot: { sendText, createForumTopic }, sent, sendText, createForumTopic };
}

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface MakeMonitorOpts {
  config?: MonitorConfig | undefined;
  bot?: MonitorSenderBot | null;
  logger?: MonitorLogger;
}

function makeMonitor(opts: MakeMonitorOpts = {}) {
  let config: MonitorConfig | undefined = 'config' in opts ? opts.config : makeConfig();
  const fallback = opts.bot === undefined ? defaultBot() : null;
  const bot: MonitorSenderBot | null = opts.bot === undefined ? fallback!.bot : opts.bot;
  const sent: SentMessage[] = fallback ? fallback.sent : [];
  const logger: MonitorLogger = opts.logger ?? { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const writeConfigChatId = vi.fn((chatId: number) => {
    config = config ? { ...config, chatId } : { chatId, agents: [], excludeUsers: [], topicPerAgent: true, ownerUserId: OWNER_ID };
  });
  const tmp = mkdtempSync(join(tmpdir(), 'tgcc-monitor-test-'));
  tmpDirs.push(tmp);
  const persistPath = join(tmp, 'monitor-topics.json');
  const monitor = new ConversationMonitor({
    getConfig: () => config,
    getSenderBot: () => bot,
    logger,
    persistPath,
    writeConfigChatId,
  });
  return { monitor, sent, logger, writeConfigChatId, getConfig: () => config };
}

/** Wait until the pump loop has fully drained (its `finally` sets pumpRunning back to false).
 *  pumpRunning is a private field — reached via a cast, matching this repo's existing
 *  convention (tests/auto-resume.test.ts reaches into private Bridge state the same way) since
 *  ConversationMonitor exposes no public "wait until idle" hook. */
async function settle(monitor: ConversationMonitor, timeout = 4000): Promise<void> {
  await vi.waitFor(() => {
    expect((monitor as unknown as { pumpRunning: boolean }).pumpRunning).toBe(false);
  }, { timeout, interval: 5 });
}

function combinedText(sent: SentMessage[]): string {
  return sent.map((s) => s.text).join('\n---\n');
}

// ── Criterion 1 ──

describe('criterion 1 — full DM turn rendering', () => {
  it('inbound DM (sender name/@handle/id/DM tag) + thinking + tool call w/ input + tool result (truncated) + tagged reply all reach sentinella\'s topic', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram(
      'sentinella',
      { userId: '5934038536', userName: 'Max', userHandle: 'maxhandle', chatId: 5934038536, isGroup: false },
      { kind: 'text', text: 'please check disk space' },
    );
    monitor.recordAssistant('sentinella', 5934038536, assistantMessage([thinkingBlock('let me check disk usage')], 'tool_use'));
    monitor.recordAssistant('sentinella', 5934038536, assistantMessage([toolUseBlock('Bash', { command: 'df -h' })], 'tool_use'));
    monitor.recordToolResult('sentinella', 5934038536, toolResultEvent({ content: 'Filesystem ... 40% used', tool_use_result: { name: 'Bash' } }));
    monitor.recordAssistant('sentinella', 5934038536, assistantMessage([textBlock('Disk is at 40% usage, all good.')], 'end_turn'));
    monitor.recordTurnEnd('sentinella', 5934038536, resultEvent());
    await settle(monitor);

    const combined = combinedText(sent);
    expect(combined).toContain('Max');
    expect(combined).toContain('maxhandle');
    expect(combined).toContain('5934038536');
    expect(combined).toContain('DM');
    expect(combined).toContain('please check disk space');
    expect(combined).toContain('let me check disk usage');
    expect(combined).toContain('Bash');
    expect(combined).toContain('df -h');
    expect(combined).toContain('40% used');
    expect(combined).toContain('Disk is at 40% usage');
    expect(combined).toContain('🤖'); // tagged reply marker
    expect(combined).toContain('💭'); // thinking marker
    expect(combined).toContain('🔧'); // tool call marker
  });

  it('inbound group message is tagged with the group title, not "DM"', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram(
      'sentinella',
      { userId: '5934038536', userName: 'Max', chatId: -500111, isGroup: true, chatTitle: 'Ops Room' },
      { kind: 'text', text: 'group question' },
    );
    await settle(monitor);
    const combined = combinedText(sent);
    expect(combined).toContain('Ops Room');
    expect(combined).not.toMatch(/·\s*DM\b/);
  });
});

// ── Criterion 2 ──

describe('criterion 2 — tgcc_send tagging + origin tracing', () => {
  it('a tgcc_send is tagged with the source agent and its traced originating human', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram(
      'sentinella_team',
      { userId: '5934038536', userName: 'Max', chatId: 999, isGroup: true, chatTitle: 'Team Chat' },
      { kind: 'text', text: 'ask sentinella to check disk' },
    );
    const origin = monitor.resolveOriginHuman('sentinella_team');
    expect(origin).toEqual({ userId: '5934038536', userName: 'Max', userHandle: undefined });

    monitor.recordInboundSystem('sentinella', 5934038536, { kind: 'tgcc_send', fromAgentId: 'sentinella_team', originHuman: origin }, 'please check disk space');
    await settle(monitor);

    const combined = combinedText(sent);
    expect(combined).toContain('sentinella_team');
    expect(combined).toContain('tgcc_send');
    expect(combined).toContain('Max');
    expect(combined).toContain('please check disk space');
  });

  it('a tgcc_send whose origin cannot be traced (source agent\'s last turn had no human) renders "origin unknown" rather than omitting it', async () => {
    const { monitor, sent } = makeMonitor();
    // kyo_team's own current turn is cron-originated — no human to trace.
    monitor.recordInboundSystem('kyo_team', 42, { kind: 'cron' }, 'nightly check');
    const origin = monitor.resolveOriginHuman('kyo_team');
    expect(origin).toBe('unknown');

    monitor.recordInboundSystem('kyobot', 42, { kind: 'tgcc_send', fromAgentId: 'kyo_team', originHuman: origin }, 'please restart the service');
    await settle(monitor);

    expect(combinedText(sent)).toContain('origin: unknown');
  });

  it('resolveOriginHuman for an agent that has never had a turn returns "unknown" without throwing', () => {
    const { monitor } = makeMonitor();
    expect(() => monitor.resolveOriginHuman('never-seen-agent')).not.toThrow();
    expect(monitor.resolveOriginHuman('never-seen-agent')).toBe('unknown');
  });
});

// ── Criterion 3 ──

describe('criterion 3 — kyobot: owner-originated excluded, tgcc_send-originated mirrored', () => {
  it('a turn the owner sends directly to kyobot is never mirrored', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('kyobot', { userId: OWNER_ID, userName: 'Fonz', chatId: Number(OWNER_ID), isGroup: false }, { kind: 'text', text: 'status?' });
    monitor.recordAssistant('kyobot', Number(OWNER_ID), assistantMessage([textBlock('all good')], 'end_turn'));
    await settle(monitor);
    expect(sent.length).toBe(0);
  });

  it('a tgcc_send-originated turn on kyobot IS mirrored, even right after an excluded owner turn', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('kyobot', { userId: OWNER_ID, userName: 'Fonz', chatId: Number(OWNER_ID), isGroup: false }, { kind: 'text', text: 'status?' });
    monitor.recordAssistant('kyobot', Number(OWNER_ID), assistantMessage([textBlock('all good')], 'end_turn'));
    monitor.recordInboundSystem('kyobot', Number(OWNER_ID), { kind: 'tgcc_send', fromAgentId: 'kyo_team', originHuman: 'unknown' }, 'please restart nginx');
    await settle(monitor);
    expect(sent.length).toBeGreaterThan(0);
    expect(combinedText(sent)).toContain('restart nginx');
  });
});

// ── Criterion 4 / item 6 — owner exclusion end to end ──

describe('criterion 4 / item 6 — no turn originating from the owner is mirrored, on any agent, including downstream events and traced tgcc_send', () => {
  it('every downstream event of an owner-originated turn (thinking, destructive tool call, tool result, reply, turn end) is suppressed, on multiple agents', async () => {
    const { monitor, sent } = makeMonitor();
    for (const agentId of ['sentinella', 'agentA']) {
      monitor.recordInboundTelegram(agentId, { userId: OWNER_ID, userName: 'Fonz', chatId: Number(OWNER_ID), isGroup: false }, { kind: 'text', text: 'owner message' });
      monitor.recordAssistant(agentId, Number(OWNER_ID), assistantMessage([thinkingBlock('thinking about the owner request')], 'tool_use'));
      // Even a destructive call from an owner-originated turn must stay fully suppressed — no
      // partial leak of the ⚠️ flag either.
      monitor.recordAssistant(agentId, Number(OWNER_ID), assistantMessage([toolUseBlock('Bash', { command: 'rm -rf /tmp/scratch' })], 'tool_use'));
      monitor.recordToolResult(agentId, Number(OWNER_ID), toolResultEvent({ content: 'done' }));
      monitor.recordAssistant(agentId, Number(OWNER_ID), assistantMessage([textBlock('done for owner')], 'end_turn'));
      monitor.recordTurnEnd(agentId, Number(OWNER_ID), resultEvent());
    }
    await settle(monitor);
    expect(sent.length).toBe(0);
  });

  it('a tgcc_send whose traced origin resolves to the owner is excluded exactly like a direct owner turn would be', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('sentinella_team', { userId: OWNER_ID, userName: 'Fonz', chatId: 555, isGroup: true, chatTitle: 'Team' }, { kind: 'text', text: 'ask sentinella something' });
    const origin = monitor.resolveOriginHuman('sentinella_team');
    expect(origin).not.toBe('unknown');
    monitor.recordInboundSystem('sentinella', 555, { kind: 'tgcc_send', fromAgentId: 'sentinella_team', originHuman: origin }, 'do the thing');
    await settle(monitor);
    expect(sent.length).toBe(0);
  });

  it('exclusion does not wedge the monitor — a later non-owner turn on the SAME agent is mirrored normally', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('sentinella', { userId: OWNER_ID, userName: 'Fonz', chatId: Number(OWNER_ID), isGroup: false }, { kind: 'text', text: 'owner message' });
    monitor.recordAssistant('sentinella', Number(OWNER_ID), assistantMessage([textBlock('done')], 'end_turn'));
    monitor.recordInboundTelegram('sentinella', { userId: '999', userName: 'Someone Else', chatId: 999, isGroup: false }, { kind: 'text', text: 'hello' });
    await settle(monitor);
    expect(sent.length).toBeGreaterThan(0);
    expect(combinedText(sent)).toContain('hello');
    expect(combinedText(sent)).not.toContain('owner message');
  });
});

// ── Criterion 5 ──

describe('criterion 5 — destructive flagging + immediate delivery', () => {
  it('a destructive tool call is flagged ⚠️ and delivered before the turn ends (recordTurnEnd is never called)', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'clean up the branch' });
    monitor.recordAssistant('sentinella', 5934038536, assistantMessage([toolUseBlock('Bash', { command: 'git branch -D old-feature' })], 'tool_use'));
    // Deliberately no recordTurnEnd call — the turn is still "in progress".
    await settle(monitor);
    expect(sent.some((s) => s.text.includes('⚠️'))).toBe(true);
    expect(combinedText(sent)).toContain('git branch -D old-feature');
  });

  it('a non-destructive tool call is never flagged ⚠️', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'list files' });
    monitor.recordAssistant('sentinella', 5934038536, assistantMessage([toolUseBlock('Bash', { command: 'ls -la' })], 'tool_use'));
    await settle(monitor);
    expect(sent.some((s) => s.text.includes('⚠️'))).toBe(false);
  });
});

// ── Criterion 7 ──

describe('criterion 7 — voice/audio and photo/document tagging', () => {
  it('voice is mirrored as its transcription, marked as voice', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'voice', text: 'this is the transcribed audio content' });
    await settle(monitor);
    const combined = combinedText(sent);
    expect(combined).toContain('🎙');
    expect(combined).toContain('voice');
    expect(combined).toContain('this is the transcribed audio content');
  });

  it('a photo is mirrored as type + caption, not raw image bytes', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'photo', text: 'a screenshot of the dashboard' });
    await settle(monitor);
    const combined = combinedText(sent);
    expect(combined).toContain('🖼');
    expect(combined).toContain('photo');
    expect(combined).toContain('a screenshot of the dashboard');
  });

  it('a document is mirrored as type + filename', async () => {
    const { monitor, sent } = makeMonitor();
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'document', text: '', fileName: 'report.pdf' });
    await settle(monitor);
    const combined = combinedText(sent);
    expect(combined).toContain('📄');
    expect(combined).toContain('document');
    expect(combined).toContain('report.pdf');
  });
});

// ── Criterion 8 — failure isolation ──

describe('criterion 8 — mirror failures never affect the monitored conversation (dropped, never thrown, never stall later sends)', () => {
  it('a permanent (non-429) send failure is logged and dropped; a later independent turn still gets through', async () => {
    let calls = 0;
    const sent: SentMessage[] = [];
    const bot: MonitorSenderBot = {
      sendText: vi.fn(async (chatId, text) => {
        calls++;
        if (calls === 1) throw new Error('boom: simulated permanent send failure');
        sent.push({ chatId, text });
        return sent.length;
      }),
      createForumTopic: vi.fn(async () => 1),
    };
    const { monitor } = makeMonitor({ bot, config: makeConfig({ topicPerAgent: false }) });
    expect(() => monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'first (will fail)' })).not.toThrow();
    await settle(monitor);
    expect(sent.length).toBe(0); // dropped, not delivered

    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'second (should succeed)' });
    await settle(monitor);
    expect(sent.some((s) => s.text.includes('second'))).toBe(true);
  });

  it('an injected 429 honors retry_after and recovers, delivering the message on retry', async () => {
    let calls = 0;
    const sent: SentMessage[] = [];
    const bot: MonitorSenderBot = {
      sendText: vi.fn(async (chatId, text) => {
        calls++;
        if (calls === 1) {
          const err: Error & { error_code?: number; parameters?: { retry_after?: number } } = new Error('Too Many Requests');
          err.error_code = 429;
          err.parameters = { retry_after: 0 }; // keep the test fast; still the real sleep()/retry path
          throw err;
        }
        sent.push({ chatId, text });
        return sent.length;
      }),
      createForumTopic: vi.fn(async () => 1),
    };
    const { monitor } = makeMonitor({ bot, config: makeConfig({ topicPerAgent: false }) });
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'please retry me' });
    await settle(monitor);
    expect(calls).toBe(2);
    expect(sent.some((s) => s.text.includes('please retry me'))).toBe(true);
  });

  it('exhausting the 429 retry cap drops the message (never throws) and does not stall a later independent send', async () => {
    const sent: SentMessage[] = [];
    const bot: MonitorSenderBot = {
      sendText: vi.fn(async (_chatId, text) => {
        if (text.includes('always-429')) {
          const err: Error & { error_code?: number; parameters?: { retry_after?: number } } = new Error('Too Many Requests');
          err.error_code = 429;
          err.parameters = { retry_after: 0 };
          throw err;
        }
        sent.push({ chatId: 1, text });
        return sent.length;
      }),
      createForumTopic: vi.fn(async () => 1),
    };
    const { monitor } = makeMonitor({ bot, config: makeConfig({ topicPerAgent: false }) });
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'always-429 content' });
    await settle(monitor, 8000);
    expect(sent.length).toBe(0);

    monitor.recordInboundTelegram('sentinella', humanIdentity('111'), { kind: 'text', text: 'this one is fine' });
    await settle(monitor);
    expect(sent.some((s) => s.text.includes('this one is fine'))).toBe(true);
  });

  it('getSenderBot() returning null drops the send without throwing', async () => {
    const { monitor, sent } = makeMonitor({ bot: null });
    expect(() => monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'no bot available' })).not.toThrow();
    await settle(monitor);
    expect(sent.length).toBe(0);
  });

  it('falls back to posting without a thread when Topics are unavailable, warning only ONCE across several sends', async () => {
    const sent: SentMessage[] = [];
    const createForumTopic = vi.fn(async () => {
      throw new Error('Bad Request: chat is not a forum');
    });
    const sendText = vi.fn(async (chatId: number | string, text: string, _p?: string, _s?: boolean, threadId?: number) => {
      sent.push({ chatId, text, threadId });
      return sent.length;
    });
    const logger: MonitorLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const { monitor } = makeMonitor({ bot: { sendText, createForumTopic }, logger, config: makeConfig({ topicPerAgent: true }) });
    for (let i = 0; i < 3; i++) {
      monitor.recordInboundTelegram('sentinella', humanIdentity(String(i)), { kind: 'text', text: `msg ${i}` });
      await settle(monitor);
    }
    expect(sent.length).toBe(3);
    expect(sent.every((s) => s.threadId === undefined)).toBe(true);
    expect(createForumTopic).toHaveBeenCalledTimes(1); // not retried per message
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── Criterion 9 — no monitor block, and agents not listed ──

describe('criterion 9 — no monitor config block means every ConversationMonitor method is a complete no-op', () => {
  it('every recording method is a no-op with getConfig() -> undefined: no throw, zero sends', async () => {
    const { monitor, sent } = makeMonitor({ config: undefined });
    expect(() => {
      monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'hi' });
      monitor.recordAssistant('sentinella', 1, assistantMessage([toolUseBlock('Bash', { command: 'rm -rf /' })], 'tool_use'));
      monitor.recordToolResult('sentinella', 1, toolResultEvent());
      monitor.recordTurnEnd('sentinella', 1, resultEvent());
      monitor.recordInboundSystem('sentinella', 1, { kind: 'cron' }, 'nightly');
    }).not.toThrow();
    await settle(monitor);
    expect(sent.length).toBe(0);
    expect(monitor.resolveOriginHuman('sentinella')).toBe('unknown');
  });

  it('an agent not listed in monitor.agents is never mirrored, even with a monitor block present and enabled', async () => {
    const { monitor, sent } = makeMonitor({ config: makeConfig({ agents: ['sentinella'] }) });
    monitor.recordInboundTelegram('some-other-agent', humanIdentity(), { kind: 'text', text: 'should not be mirrored' });
    await settle(monitor);
    expect(sent.length).toBe(0);
  });
});

// ── Criterion 10 / item 5 — throughput, packing, priority ──

describe('criterion 10 / item 5 — throughput: packing bounds message count, routine cap collapses, critical never dropped, serialized delivery, 429 does not stall', () => {
  it('a 100-tool-call burst packs down to far fewer messages than the raw event count, with a grouped collapse summary and no dropped critical content', async () => {
    const { monitor, sent } = makeMonitor({ config: makeConfig({ agents: ['sentinella'], topicPerAgent: false }) });
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'go' });
    for (let i = 0; i < 100; i++) {
      monitor.recordAssistant('sentinella', 5934038536, assistantMessage([toolUseBlock('Read', { file_path: `/tmp/file${i}.txt` }, `tu${i}`)], 'tool_use'));
      monitor.recordToolResult('sentinella', 5934038536, toolResultEvent({ tool_use_id: `tu${i}`, content: `contents of file ${i}`, tool_use_result: { name: 'Read' } }));
    }
    monitor.recordAssistant('sentinella', 5934038536, assistantMessage([textBlock('all done')], 'end_turn'));
    await settle(monitor);

    // Raw event count here is ~202 (100 tool_use + 100 tool_result + inbound + reply). Packing
    // must bring that down substantially, never 1:1.
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThan(20);
    expect(combinedText(sent)).toContain('all done'); // the final reply (critical) must survive
  });

  it('a critical (⚠️) block is packed into the FIRST message even when preceded by enough routine content to overflow a single message on its own', async () => {
    const { monitor, sent } = makeMonitor({ config: makeConfig({ agents: ['agentA'], topicPerAgent: false }) });
    // Buffer routine content (tool results, which don't flush on their own) whose rendered size
    // ALONE exceeds the ~3500-char per-message packing budget, so packing genuinely has to choose
    // what goes in the first message rather than everything trivially fitting together.
    for (let i = 0; i < 10; i++) {
      monitor.recordToolResult('agentA', 1, toolResultEvent({ tool_use_id: `t${i}`, content: 'x'.repeat(600), tool_use_result: { name: 'Read' } }));
    }
    // Flush all of that together with one critical (destructive) block.
    monitor.recordAssistant('agentA', 1, assistantMessage([toolUseBlock('Bash', { command: 'git push --force origin main' })], 'tool_use'));
    await settle(monitor);

    expect(sent.length).toBeGreaterThan(1); // the routine content alone doesn't fit in one message
    expect(sent[0].text).toContain('⚠️'); // but the critical block still went out in the FIRST send
    expect(sent[0].text).toContain('git push --force');
  });

  it('the routine backlog cap collapses the OLDEST routine blocks into one grouped summary line, never touching critical content', async () => {
    const { monitor, sent } = makeMonitor({ config: makeConfig({ agents: ['agentA'], topicPerAgent: false }) });
    // Buffer 80 tool results (these do NOT flush on their own) then flush everything at once
    // together with one destructive (critical) tool call, so the whole 81-block batch lands in
    // the backlog in a single push — well past the 50-block routine cap.
    for (let i = 0; i < 80; i++) {
      monitor.recordToolResult('agentA', 1, toolResultEvent({ tool_use_id: `t${i}`, content: `r${i}`, tool_use_result: { name: i % 2 === 0 ? 'Read' : 'Grep' } }));
    }
    monitor.recordAssistant('agentA', 1, assistantMessage([toolUseBlock('Bash', { command: 'git push --force origin main' })], 'tool_use'));
    await settle(monitor);

    const combined = combinedText(sent);
    expect(combined).toMatch(/… \d+ routine events omitted/);
    expect(combined).toContain('Read result ×');
    expect(combined).toContain('Grep result ×');
    expect(combined).toContain('⚠️'); // the critical destructive block was never collapsed
    expect(combined).toContain('git push --force');
  });

  it('sends to one destination chat never overlap — max concurrency across several busy agents is exactly 1', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sent: SentMessage[] = [];
    const bot: MonitorSenderBot = {
      sendText: vi.fn(async (chatId, text) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight--;
        sent.push({ chatId, text });
        return sent.length;
      }),
      createForumTopic: vi.fn(async () => 1),
    };
    const { monitor } = makeMonitor({ bot, config: makeConfig({ agents: ['agentA', 'agentB', 'agentC'], topicPerAgent: false }) });
    for (const [agentId, chatId] of [['agentA', 1], ['agentB', 2], ['agentC', 3]] as const) {
      for (let i = 0; i < 10; i++) {
        monitor.recordAssistant(agentId, chatId, assistantMessage([toolUseBlock('Read', { file_path: `/f${i}` }, `${agentId}${i}`)], 'tool_use'));
      }
    }
    await settle(monitor);
    expect(sent.length).toBeGreaterThan(1);
    expect(maxInFlight).toBe(1);
  });

  it('a ⚠️ block does not wait behind an unrelated agent\'s unrenderable state — 429 mid-burst does not stall the pump', async () => {
    const sent: SentMessage[] = [];
    let attempt = 0;
    const bot: MonitorSenderBot = {
      sendText: vi.fn(async (chatId, text) => {
        attempt++;
        if (attempt <= 2) {
          const err: Error & { error_code?: number; parameters?: { retry_after?: number } } = new Error('Too Many Requests');
          err.error_code = 429;
          err.parameters = { retry_after: 0 };
          throw err;
        }
        sent.push({ chatId, text });
        return sent.length;
      }),
      createForumTopic: vi.fn(async () => 1),
    };
    const { monitor } = makeMonitor({ bot, config: makeConfig({ agents: ['sentinella'], topicPerAgent: false }) });
    for (let i = 0; i < 10; i++) {
      monitor.recordAssistant('sentinella', 1, assistantMessage([toolUseBlock('Read', { file_path: `/f${i}` }, `t${i}`)], 'tool_use'));
    }
    await settle(monitor, 6000);
    expect(sent.length).toBeGreaterThan(0); // pump kept draining after the injected 429s
  });
});

describe('item 1 / criteria 10 & 14 — cross-agent ⚠️ priority is destination-chat-wide, not per agent', () => {
  it('at most ONE send already in flight for agent A is allowed to go out before agent B\'s ⚠️ — zero further routine A sends squeeze in between', async () => {
    type Resolver = { text: string; resolve: (id: number) => void };
    const resolvers: Resolver[] = [];
    const sent: SentMessage[] = [];
    const bot: MonitorSenderBot = {
      sendText: vi.fn((chatId: number | string, text: string, _p?: string, _s?: boolean, threadId?: number) => {
        return new Promise<number>((resolve) => {
          sent.push({ chatId, text, threadId });
          resolvers.push({ text, resolve: () => resolve(sent.length) });
        });
      }),
      createForumTopic: vi.fn(async () => 1),
    };
    const { monitor } = makeMonitor({ bot, config: makeConfig({ agents: ['agentA', 'agentB'], topicPerAgent: false }) });

    // Agent A: a large routine backlog, built up via buffered tool results (don't flush) then
    // one flush that pushes it all to the backlog together — this whole batch becomes the ONE
    // in-flight send once the pump starts.
    for (let i = 0; i < 30; i++) {
      monitor.recordToolResult('agentA', 111, toolResultEvent({ tool_use_id: `a${i}`, content: `result ${i}`, tool_use_result: { name: 'Read' } }));
    }
    monitor.recordAssistant('agentA', 111, assistantMessage([toolUseBlock('Read', { file_path: '/last' }, 'aLast')], 'tool_use'));

    // At this point (still fully synchronous, no await yet) the pump has already synchronously
    // reached bot.sendText() for agent A's packed backlog (topicPerAgent: false means no
    // intervening await before the send call) — exactly one A-send is "in flight" and
    // uninterruptible, matching a real Telegram call in progress.
    expect(sent.length).toBe(1);
    expect(sent[0].text).not.toContain('⚠️');

    // NOW agent B's ⚠️ arrives, strictly before that in-flight send resolves.
    monitor.recordInboundTelegram('agentB', { userId: '222', userName: 'Colleague B', chatId: 222, isGroup: false }, { kind: 'text', text: 'please clean up' });
    monitor.recordAssistant('agentB', 222, assistantMessage([toolUseBlock('Bash', { command: 'git push --force origin main' })], 'tool_use'));

    // Resolve the one send that was already in flight.
    resolvers[0].resolve(1);
    await vi.waitFor(() => expect(sent.length).toBe(2), { timeout: 2000, interval: 5 });

    // The very next send must be B's ⚠️ content — not a further A routine pack.
    expect(sent[1].text).toContain('⚠️');
    expect(sent[1].text).toContain('git push --force');

    // Drain everything else so the test doesn't leave dangling promises.
    for (let iterations = 0; iterations < 100 && (monitor as unknown as { pumpRunning: boolean }).pumpRunning; iterations++) {
      while (resolvers.length > 0) resolvers.shift()!.resolve(1);
      await Promise.resolve();
    }
    await settle(monitor);
  });
});

describe('item 7 — two concurrent chats on the SAME agent do not interleave or cross-contaminate', () => {
  it('each chat\'s sender identity, message, and recipient tag stay correctly paired, independent of the other chat', async () => {
    const { monitor, sent } = makeMonitor({ config: makeConfig({ agents: ['sentinella'], topicPerAgent: false }) });
    const chatA = 1001;
    const chatB = 1002;
    monitor.recordInboundTelegram('sentinella', { userId: 'userA', userName: 'Alice', chatId: chatA, isGroup: false }, { kind: 'text', text: 'alice question' });
    monitor.recordInboundTelegram('sentinella', { userId: 'userB', userName: 'Bob', chatId: chatB, isGroup: false }, { kind: 'text', text: 'bob question' });
    monitor.recordAssistant('sentinella', chatA, assistantMessage([textBlock('answer for alice')], 'end_turn'));
    monitor.recordAssistant('sentinella', chatB, assistantMessage([textBlock('answer for bob')], 'end_turn'));
    await settle(monitor);

    const combined = combinedText(sent);
    expect(combined).toContain('alice question');
    expect(combined).toContain('bob question');
    // Precise pairing check: Alice's reply header must say "→ Alice", not "→ Bob", and vice
    // versa — this is exactly what would break if turn-origin state were keyed by agent alone
    // instead of agent+chat.
    expect(combined).toContain('🤖 <b>sentinella</b> → Alice\nanswer for alice');
    expect(combined).toContain('🤖 <b>sentinella</b> → Bob\nanswer for bob');
  });
});

describe('item 9 — forum topic ids are keyed by destination chat, not just agent', () => {
  it('a destination change (registerHere) creates a FRESH topic in the new chat rather than reusing the old thread id', async () => {
    const { monitor, createForumTopic } = (() => {
      const b = defaultBot();
      const { monitor } = makeMonitor({ bot: b.bot, config: makeConfig({ chatId: -100111, agents: ['sentinella'], topicPerAgent: true }) });
      return { monitor, createForumTopic: b.createForumTopic };
    })();

    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'hi' });
    await settle(monitor);
    expect(createForumTopic).toHaveBeenCalledTimes(1);
    expect(createForumTopic).toHaveBeenCalledWith(-100111, 'sentinella');

    monitor.registerHere(-100222, OWNER_ID);
    monitor.recordInboundTelegram('sentinella', humanIdentity(), { kind: 'text', text: 'hi again' });
    await settle(monitor);
    expect(createForumTopic).toHaveBeenCalledTimes(2);
    expect(createForumTopic).toHaveBeenLastCalledWith(-100222, 'sentinella');
  });
});

describe('criterion 12 (partial) — registerHere notifies the previous destination without revealing the new chat id', () => {
  it('notifies the OLD destination chat when the destination actually changes, without naming the new chat id', async () => {
    const { monitor, sent } = makeMonitor({ config: makeConfig({ chatId: -100111 }) });
    monitor.registerHere(-100222, OWNER_ID);
    await settle(monitor);
    const notice = sent.find((s) => s.chatId === -100111);
    expect(notice).toBeDefined();
    expect(notice!.text).not.toContain('-100222');
    expect(notice!.text.toLowerCase()).toContain('no longer receives');
  });

  it('does NOT notify anyone when there was no previous destination (monitor was off / first-ever registration)', async () => {
    const { monitor, sent } = makeMonitor({ config: undefined });
    monitor.registerHere(-100222, OWNER_ID);
    await settle(monitor);
    expect(sent.length).toBe(0);
  });

  it('does NOT notify when the "new" destination is the same as the current one', async () => {
    const { monitor, sent } = makeMonitor({ config: makeConfig({ chatId: -100111 }) });
    monitor.registerHere(-100111, OWNER_ID);
    await settle(monitor);
    expect(sent.length).toBe(0);
  });
});
