// tests/monitor-bridge.test.ts
//
// Regression coverage for the Bridge-level conversation-monitor wiring — acceptance criteria
// 13 and 14 from work/agent-conversation-monitor/PLAN.md, plus items 2, 4, 6 and 8 from the
// test brief: the monitor-destination-chat exclusion (isMonitorDestinationChat), the
// private-chat-destination lockout fix, owner-exclusion through the REAL sendSupervisorMessage
// wiring (not just the ConversationMonitor unit), and an explicit "no monitor block changes
// nothing" check at the Bridge level.
//
// Bridge's constructor is not designed for dependency injection (RalphManager/ExternalCcManager
// hard-code join(homedir(), '.tgcc', ...), and ConversationMonitor's default persistPath does
// the same) — this file follows the exact hermetic pattern already established in
// tests/auto-resume.test.ts: mock node:os's homedir() for the whole file, construct a real
// Bridge, and hand-populate `agents` the way startAgent() would (minus a real grammy Bot —
// tgBot is a plain mock object satisfying only the methods these code paths call). Private
// Bridge methods (handleTelegramMessage, handleSlashCommand, sendSupervisorMessage) are reached
// via `as any`, matching the seam auto-resume.test.ts already established for
// autoResumeSessions(). No real Telegram calls anywhere.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';

let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

const { Bridge } = await import('../src/bridge.js');
const { ConversationMonitor } = await import('../src/monitor.js');

const logger = pino({ level: 'silent' });
const OWNER_ID = '7016073156';
const COLLEAGUE_ID = '5934038536';
const SUPERVISOR_ID = 'supervisorAgent';
const TARGET_ID = 'sentinella';
const SOURCE_ID = 'sentinella_team';
const MONITOR_GROUP_CHAT = -1009998887776;

let tmpDir: string;
let repo: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'tgcc-monitor-bridge-'));
  fakeHome = tmpDir;
  repo = join(tmpDir, 'repo', 'color');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function agentDefaults() {
  return {
    model: 'sonnet',
    repo,
    idleTimeoutMs: 1000,
    hangTimeoutMs: 1000,
    permissionMode: 'default' as const,
  };
}

/** monitorBlock === null means the "monitor" key is entirely absent from config (feature off). */
function buildConfig(monitorBlock: Record<string, unknown> | null | undefined) {
  return {
    global: {
      ccBinaryPath: 'claude',
      mediaDir: join(tmpDir, 'media'),
      socketDir: join(tmpDir, 'sockets'),
      ctlSocketDir: join(tmpDir, 'ctl'),
      mcpConfigDir: join(tmpDir, 'mcp'),
      logLevel: 'silent',
      stateFile: join(tmpDir, '.tgcc-state', 'state.json'),
      authFallbackEnabled: false,
      authFallbackTimeoutMs: 300000,
      tmux: false,
    },
    repos: { color: repo },
    agents: {
      [SUPERVISOR_ID]: { botToken: 'sup-token', allowedUsers: [OWNER_ID], defaults: agentDefaults() },
      [TARGET_ID]: { botToken: 'target-token', allowedUsers: [OWNER_ID, COLLEAGUE_ID], defaults: agentDefaults() },
      [SOURCE_ID]: { botToken: 'source-token', allowedUsers: [OWNER_ID, COLLEAGUE_ID], defaults: agentDefaults() },
    },
    supervisor: SUPERVISOR_ID,
    ...(monitorBlock === null ? {} : { monitor: monitorBlock }),
  };
}

function defaultMonitorBlock(overrides: Record<string, unknown> = {}) {
  return {
    chatId: MONITOR_GROUP_CHAT,
    agents: [TARGET_ID, SOURCE_ID],
    excludeUsers: [OWNER_ID],
    topicPerAgent: false,
    ownerUserId: OWNER_ID,
    ...overrides,
  };
}

function mockTgBot() {
  return {
    sendText: vi.fn(async () => 1),
    editText: vi.fn(async () => {}),
    editTextWithKeyboard: vi.fn(async () => {}),
    createForumTopic: vi.fn(async () => 1),
    getGroupRoster: vi.fn(() => null),
  };
}

/** Construct a real Bridge and hand-populate `agents`, minus a real grammy Bot — mirrors
 *  tests/auto-resume.test.ts's buildBridge(). Returns `any` since AgentInstance is private/
 *  unexported, the seam this codebase's own tests already use. */
function buildBridge(monitorBlock: Record<string, unknown> | null | undefined): any {
  const config = buildConfig(monitorBlock);
  const bridge = new Bridge(config as any, logger) as any;
  for (const id of [SUPERVISOR_ID, TARGET_ID, SOURCE_ID]) {
    bridge.agents.set(id, {
      id,
      config: (config.agents as Record<string, unknown>)[id],
      tgBot: mockTgBot(),
      ephemeral: false,
      repo,
      model: 'sonnet',
      chatSessions: new Map(),
      pendingPermissions: new Map(),
      pendingExecApprovals: new Map(),
      lastTgChatId: null,
      lastTgUserId: null,
      destroyTimer: null,
      eventBuffer: null,
      awaitingAskCleanup: false,
      muteOutput: false,
      authFlowInProgress: false,
      lastSendData: null,
      claudeConfigDir: undefined,
      pendingCliTmuxAgent: null,
    });
  }
  // Never spawn a real CC process from these tests — every scenario here is about whether the
  // message/command reaches the point of being handed to sendToCC, not what CC does with it.
  bridge.sendToCC = vi.fn(async () => {});

  // Defence in depth, unconditionally: replace Bridge's own ConversationMonitor (which by
  // default persists topics to ~/.tgcc/monitor-topics.json and writes /monitor_here's chat id
  // via updateConfig() -> the real ~/.tgcc/config.json) with one whose persistence is fully
  // contained in this test's tmp dir and whose config-write is a plain spy. This must hold even
  // under a hypothetical auth-check regression: an earlier run of this exact suite, during
  // deliberate mutation-testing of checkMonitorHereAuth (see the test-run report), proved that a
  // weakened auth check makes handleSlashCommand's 'monitor_here' case reach the REAL
  // registerHere()/updateConfig() path even from a test that never expected it to. Never rely on
  // "this test doesn't call monitor_here" to keep persistence hermetic — always override.
  bridge.monitor = new ConversationMonitor({
    getConfig: () => bridge.config.monitor,
    getSenderBot: () => bridge.agents.get(bridge.nativeSupervisorId)?.tgBot ?? null,
    logger,
    persistPath: join(tmpDir, 'monitor-topics.json'),
    writeConfigChatId: vi.fn(),
  });
  return bridge;
}

function tgMessage(overrides: { chatId: number; userId: string; userName?: string; text?: string }) {
  return {
    type: 'text' as const,
    chatId: overrides.chatId,
    userId: overrides.userId,
    userName: overrides.userName ?? 'Test User',
    text: overrides.text ?? 'hello',
  };
}

async function settle(monitor: unknown, timeout = 3000): Promise<void> {
  await vi.waitFor(() => {
    expect((monitor as { pumpRunning: boolean }).pumpRunning).toBe(false);
  }, { timeout, interval: 5 });
}

// ── Criterion 13 / item 4 — monitor destination chat exclusion (group only) ──

describe('criterion 13 / item 4 — the monitor destination chat is a one-way feed, not a conversation (group destination)', () => {
  it('an ordinary message from the owner in the group destination chat, on the supervisor bot, never reaches the agent', () => {
    const bridge = buildBridge(defaultMonitorBlock());
    const recordSpy = vi.spyOn(bridge.monitor, 'recordInboundTelegram');

    bridge.handleTelegramMessage(SUPERVISOR_ID, tgMessage({ chatId: MONITOR_GROUP_CHAT, userId: OWNER_ID, text: 'a note in the mirror feed' }));

    expect(recordSpy).not.toHaveBeenCalled();
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);
    expect(supervisorAgent.chatSessions.size).toBe(0);
    expect(bridge.sendToCC).not.toHaveBeenCalled();
  });

  it('/new and other ordinary commands are silently ignored in the group destination chat — no reply sent', async () => {
    const bridge = buildBridge(defaultMonitorBlock());
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);

    await bridge.handleSlashCommand(SUPERVISOR_ID, { command: 'new', args: '', chatId: MONITOR_GROUP_CHAT, userId: OWNER_ID });

    expect(supervisorAgent.tgBot.sendText).not.toHaveBeenCalled();
  });

  it('/status still works in the group destination chat (explicitly allowed alongside monitor_here)', async () => {
    const bridge = buildBridge(defaultMonitorBlock());
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);

    await bridge.handleSlashCommand(SUPERVISOR_ID, { command: 'status', args: '', chatId: MONITOR_GROUP_CHAT, userId: OWNER_ID });

    expect(supervisorAgent.tgBot.sendText).toHaveBeenCalledTimes(1);
  });

  it('/monitor_here works end-to-end in the group destination chat for the owner on the supervisor bot (the one exempted command)', async () => {
    const bridge = buildBridge(defaultMonitorBlock({ chatId: -1005550001 }));
    // Re-attach with a NAMED spy (buildBridge already attaches a safe controlled monitor by
    // default — see its own comment — this just swaps in a spy we can assert on by name).
    const writeConfigChatId = vi.fn();
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);
    bridge.monitor = new ConversationMonitor({
      getConfig: () => bridge.config.monitor,
      getSenderBot: () => bridge.agents.get(bridge.nativeSupervisorId)?.tgBot ?? null,
      logger,
      persistPath: join(tmpDir, 'monitor-topics.json'),
      writeConfigChatId,
    });

    await bridge.handleSlashCommand(SUPERVISOR_ID, { command: 'monitor_here', args: '', chatId: MONITOR_GROUP_CHAT, userId: OWNER_ID });

    expect(writeConfigChatId).toHaveBeenCalledWith(MONITOR_GROUP_CHAT);
    expect(supervisorAgent.tgBot.sendText).toHaveBeenCalledWith(
      MONITOR_GROUP_CHAT,
      expect.stringContaining('now the conversation monitor destination'),
      'HTML',
    );
  });
});

// ── Item 2 / criterion 14 — private-chat destination must never lock the owner out ──

describe('item 2 / criterion 14 — a private-chat (DM) monitor destination never suppresses the owner, on any agent', () => {
  it('the owner\'s DM to a regular monitored agent is unaffected when the destination is a DM equal to the owner\'s own id (the PLAN.md bootstrap scenario)', () => {
    const bridge = buildBridge(defaultMonitorBlock({ chatId: Number(OWNER_ID) }));
    const recordSpy = vi.spyOn(bridge.monitor, 'recordInboundTelegram');

    bridge.handleTelegramMessage(TARGET_ID, tgMessage({ chatId: Number(OWNER_ID), userId: OWNER_ID, text: 'hello agent' }));

    expect(recordSpy).toHaveBeenCalled();
    const targetAgent = bridge.agents.get(TARGET_ID);
    expect(targetAgent.chatSessions.size).toBe(1);
  });

  it('the owner\'s /status to that same agent, in the same DM, is unaffected too', async () => {
    const bridge = buildBridge(defaultMonitorBlock({ chatId: Number(OWNER_ID) }));
    const targetAgent = bridge.agents.get(TARGET_ID);

    await bridge.handleSlashCommand(TARGET_ID, { command: 'status', args: '', chatId: Number(OWNER_ID), userId: OWNER_ID });

    expect(targetAgent.tgBot.sendText).toHaveBeenCalledTimes(1);
  });

  it('the owner\'s DM to the SUPERVISOR bot itself (agentId === nativeSupervisorId, chatId still a DM) is unaffected — chatId >= 0 wins over the agent-identity check', () => {
    const bridge = buildBridge(defaultMonitorBlock({ chatId: Number(OWNER_ID) }));
    const recordSpy = vi.spyOn(bridge.monitor, 'recordInboundTelegram');

    bridge.handleTelegramMessage(SUPERVISOR_ID, tgMessage({ chatId: Number(OWNER_ID), userId: OWNER_ID, text: 'hello supervisor' }));

    expect(recordSpy).toHaveBeenCalled();
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);
    expect(supervisorAgent.chatSessions.size).toBe(1);
  });

  it('regression guard: a GROUP destination (negative chatId) on the supervisor bot still excludes exactly as before — the DM fix did not overcorrect', () => {
    const bridge = buildBridge(defaultMonitorBlock({ chatId: MONITOR_GROUP_CHAT }));
    const recordSpy = vi.spyOn(bridge.monitor, 'recordInboundTelegram');

    bridge.handleTelegramMessage(SUPERVISOR_ID, tgMessage({ chatId: MONITOR_GROUP_CHAT, userId: OWNER_ID, text: 'note' }));

    expect(recordSpy).not.toHaveBeenCalled();
  });

  it('the group-destination exclusion only applies on the bot that actually posts there — a DIFFERENT agent whose bot happens to see the same numeric (negative) chat id is unaffected (defence-in-depth agentId check)', () => {
    const bridge = buildBridge(defaultMonitorBlock({ chatId: MONITOR_GROUP_CHAT }));
    const recordSpy = vi.spyOn(bridge.monitor, 'recordInboundTelegram');

    bridge.handleTelegramMessage(TARGET_ID, tgMessage({ chatId: MONITOR_GROUP_CHAT, userId: COLLEAGUE_ID, text: 'hi' }));

    expect(recordSpy).toHaveBeenCalled();
  });
});

// ── Item 8 — no monitor block, Bridge behaviour is unchanged ──

describe('item 8 — with no "monitor" block in config, Bridge behaviour is byte-for-byte unchanged', () => {
  it('an ordinary message reaches the agent exactly as it would without the feature, and the monitor never sends anything', () => {
    const bridge = buildBridge(null);
    const recordSpy = vi.spyOn(bridge.monitor, 'recordInboundTelegram');

    bridge.handleTelegramMessage(TARGET_ID, tgMessage({ chatId: 555444, userId: COLLEAGUE_ID, text: 'hello' }));

    // The wiring call always happens (harmless) — but nothing about the normal flow changes.
    expect(recordSpy).toHaveBeenCalled();
    const targetAgent = bridge.agents.get(TARGET_ID);
    expect(targetAgent.chatSessions.size).toBe(1);
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);
    expect(supervisorAgent.tgBot.sendText).not.toHaveBeenCalled();
  });

  it('handleSlashCommand never applies the monitor-destination-chat guard when there is no monitor block (isMonitorDestinationChat is unconditionally false)', async () => {
    const bridge = buildBridge(null);
    const targetAgent = bridge.agents.get(TARGET_ID);

    await bridge.handleSlashCommand(TARGET_ID, { command: 'status', args: '', chatId: -999999, userId: COLLEAGUE_ID });

    expect(targetAgent.tgBot.sendText).toHaveBeenCalledTimes(1);
  });

  it('/monitor_here itself is rejected (not-supervisor-bot or owner-not-configured) rather than doing anything, when there is no monitor block', async () => {
    const bridge = buildBridge(null);
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);

    await bridge.handleSlashCommand(SUPERVISOR_ID, { command: 'monitor_here', args: '', chatId: MONITOR_GROUP_CHAT, userId: OWNER_ID });

    // owner-not-configured path replies with a specific setup message; either way nothing about
    // the destination is registered.
    expect(supervisorAgent.tgBot.sendText).toHaveBeenCalledWith(
      MONITOR_GROUP_CHAT,
      expect.stringContaining('ownerUserId'),
      'HTML',
    );
  });
});

// ── Item 6 — owner exclusion through the REAL sendSupervisorMessage wiring ──

describe('item 6 — owner exclusion through the real bridge.sendSupervisorMessage wiring (tgcc_send traced back to the owner)', () => {
  it('a tgcc_send whose traced origin is the owner is excluded end-to-end — the monitor never sends anything, even though the normal in-chat notification still fires', async () => {
    const bridge = buildBridge(defaultMonitorBlock());
    const targetAgent = bridge.agents.get(TARGET_ID);
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);

    // Establish SOURCE_ID's current turn as owner-originated, exactly as queueForChat would.
    bridge.monitor.recordInboundTelegram(SOURCE_ID, { userId: OWNER_ID, userName: 'Fonz', chatId: 555, isGroup: true, chatTitle: 'Team' }, { kind: 'text', text: 'ask sentinella something' });

    const recordSpy = vi.spyOn(bridge.monitor, 'recordInboundSystem');
    bridge.sendSupervisorMessage(TARGET_ID, 'do the thing', SOURCE_ID);
    await settle(bridge.monitor);

    // The wiring itself is correct (traces + tags before handing off to the monitor)...
    expect(recordSpy).toHaveBeenCalledWith(TARGET_ID, expect.any(Number), expect.objectContaining({ kind: 'tgcc_send', fromAgentId: SOURCE_ID }), 'do the thing');
    // ...but the END RESULT is that nothing was mirrored, because the traced origin is the owner.
    expect(supervisorAgent.tgBot.sendText).not.toHaveBeenCalled();
    // The normal (non-monitor) in-chat supervisor notification to the target agent still fires —
    // owner-exclusion must not suppress ordinary bridge behaviour, only the mirror.
    expect(targetAgent.tgBot.sendText).toHaveBeenCalled();
  });

  it('positive control: a tgcc_send whose traced origin is NOT the owner IS mirrored, via the same real wiring', async () => {
    const bridge = buildBridge(defaultMonitorBlock());
    const supervisorAgent = bridge.agents.get(SUPERVISOR_ID);

    bridge.monitor.recordInboundTelegram(SOURCE_ID, { userId: COLLEAGUE_ID, userName: 'Max', chatId: 555, isGroup: true, chatTitle: 'Team' }, { kind: 'text', text: 'ask sentinella something' });

    bridge.sendSupervisorMessage(TARGET_ID, 'do the other thing', SOURCE_ID);
    await settle(bridge.monitor);

    expect(supervisorAgent.tgBot.sendText).toHaveBeenCalled();
    const mirrored = supervisorAgent.tgBot.sendText.mock.calls.some((c: unknown[]) => typeof c[1] === 'string' && c[1].includes('do the other thing'));
    expect(mirrored).toBe(true);
  });
});
