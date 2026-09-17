// tests/monitor-auth.test.ts
//
// Regression coverage for /monitor_here authorization — acceptance criterion 12 plus the
// "specifically weak" item from the test brief: `checkMonitorHereAuth` (src/bridge.ts) was
// already unit-checked by the dev, but nobody had proven that a real `TelegramBot` (src/
// telegram.ts) constructed with `isSupervisorBot: false` actually never dispatches the
// command at the routing layer — this file closes that gap plus the BotFather-menu gating.
//
// Hermetic: no real Telegram calls anywhere. TelegramBot wraps a real grammy `Bot` instance,
// but we never call `.start()` or `refreshCommands()` (both would hit the real Bot API via
// grammy's HTTP client) — dispatch is exercised via `bot.handleUpdate()` on a synthetic Update
// object, which runs entirely in-process middleware with no network I/O. `botInfo` is set
// directly (grammy's supported "skip the getMe() call" path) so `handleUpdate` doesn't need
// `bot.init()` either.

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { TelegramBot, type TelegramMessage, type SlashCommand } from '../src/telegram.js';
import { checkMonitorHereAuth, type MonitorHereAuthResult } from '../src/bridge.js';
import type { AgentConfig } from '../src/config.js';

const logger = pino({ level: 'silent' });

// ── checkMonitorHereAuth — pure function, every branch ──

describe('checkMonitorHereAuth', () => {
  const SUPERVISOR = 'supervisorAgent';
  const OWNER = '7016073156';
  const COLLEAGUE = '5934038536'; // e.g. one of sentinella's allowedUsers per the plan's example

  it('rejects when the agent is not the native supervisor, even if the caller is the owner', () => {
    const result = checkMonitorHereAuth('sentinella', SUPERVISOR, OWNER, OWNER);
    expect(result).toEqual<MonitorHereAuthResult>({ ok: false, reason: 'not-supervisor-bot' });
  });

  it('rejects on a non-supervisor bot even when the caller id happens to equal the configured owner id — the exact attack the fix targets', () => {
    // A colleague could never BE the owner's id, but this proves the bot-identity check runs
    // independently of who the caller claims to be, not "any id on any bot works if it matches".
    const result = checkMonitorHereAuth('sentinella', SUPERVISOR, OWNER, OWNER);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not-supervisor-bot');
  });

  it('rejects when there is no native supervisor configured at all (nativeSupervisorId null)', () => {
    const result = checkMonitorHereAuth(SUPERVISOR, null, OWNER, OWNER);
    expect(result).toEqual<MonitorHereAuthResult>({ ok: false, reason: 'not-supervisor-bot' });
  });

  it('rejects when ownerUserId is not configured, even on the supervisor bot', () => {
    const result = checkMonitorHereAuth(SUPERVISOR, SUPERVISOR, OWNER, undefined);
    expect(result).toEqual<MonitorHereAuthResult>({ ok: false, reason: 'owner-not-configured' });
  });

  it('rejects a non-owner caller on the supervisor bot', () => {
    const result = checkMonitorHereAuth(SUPERVISOR, SUPERVISOR, COLLEAGUE, OWNER);
    expect(result).toEqual<MonitorHereAuthResult>({ ok: false, reason: 'not-owner' });
  });

  it('accepts the owner on the supervisor bot', () => {
    const result = checkMonitorHereAuth(SUPERVISOR, SUPERVISOR, OWNER, OWNER);
    expect(result).toEqual<MonitorHereAuthResult>({ ok: true });
  });

  it('does NOT infer the owner from anything except an exact ownerUserId string match (no loose/numeric coercion)', () => {
    // "7016073156" vs " 7016073156" (whitespace) must not be treated as equal.
    const result = checkMonitorHereAuth(SUPERVISOR, SUPERVISOR, ' 7016073156', OWNER);
    expect(result.ok).toBe(false);
  });
});

// ── TelegramBot routing-level wiring: does a non-supervisor bot ever dispatch /monitor_here? ──

function baseAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    botToken: 'x',
    allowedUsers: ['111'],
    defaults: {
      model: 'sonnet',
      repo: '/tmp/repo',
      idleTimeoutMs: 1000,
      hangTimeoutMs: 1000,
      permissionMode: 'default',
    },
    ...overrides,
  };
}

/** A synthetic Telegram Update carrying a slash command, with the `bot_command` entity Telegram
 *  itself would attach — grammy's command-matching filter (`Context.has.command`) reads this
 *  entity, not just the leading "/", so a fixture without it would silently never match. */
function commandUpdate(commandText: string, opts: { chatId: number; userId: number }) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: opts.chatId, type: 'private' as const, first_name: 'Test' },
      from: { id: opts.userId, is_bot: false, first_name: 'Test', username: 'testuser' },
      text: commandText,
      entities: [{ type: 'bot_command' as const, offset: 0, length: commandText.length }],
    },
  };
}

/** Build a TelegramBot with botInfo pre-set (skips the real getMe() network call — grammy's
 *  documented way to pre-initialize) and return spies for its onMessage/onCommand callbacks,
 *  plus the raw inner grammy Bot (for feeding synthetic updates via handleUpdate). */
function buildTelegramBot(isSupervisorBot: boolean, userId: number) {
  const onMessage = vi.fn<(msg: TelegramMessage) => void>();
  const onCommand = vi.fn<(cmd: SlashCommand) => void>();
  const config = baseAgentConfig({ allowedUsers: [String(userId)] });
  const tgBot = new TelegramBot('agentUnderTest', config, '/tmp', onMessage, onCommand, logger, undefined, isSupervisorBot);
  const innerBot = (tgBot as unknown as { bot: { botInfo: unknown; handleUpdate: (u: unknown) => Promise<void> } }).bot;
  // Pre-set botInfo so handleUpdate() doesn't require a real getMe() call.
  innerBot.botInfo = { id: 999, is_bot: true, first_name: 'Test Bot', username: 'test_bot' };
  return { tgBot, innerBot, onMessage, onCommand };
}

describe('TelegramBot — /monitor_here routing (isSupervisorBot gating)', () => {
  it('a non-supervisor bot NEVER dispatches /monitor_here to onCommand (falls through, ignored — not even treated as plain text)', async () => {
    const userId = 111;
    const { innerBot, onMessage, onCommand } = buildTelegramBot(false, userId);

    await innerBot.handleUpdate(commandUpdate('/monitor_here', { chatId: userId, userId }));

    expect(onCommand).not.toHaveBeenCalled();
    // handleText() explicitly bails out for anything starting with "/" — so it must not leak
    // through as an ordinary text message either.
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('positive control: the SAME update on a supervisor bot DOES dispatch onCommand("monitor_here") — proves the fixture/harness itself is valid, not just trivially green', async () => {
    const userId = 111;
    const { innerBot, onCommand } = buildTelegramBot(true, userId);

    await innerBot.handleUpdate(commandUpdate('/monitor_here', { chatId: userId, userId }));

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'monitor_here', userId: String(userId) }));
  });

  it('a non-supervisor bot still dispatches its OTHER ordinary commands normally (the gating is specific to monitor_here, not a general breakage)', async () => {
    const userId = 111;
    const { innerBot, onCommand } = buildTelegramBot(false, userId);

    await innerBot.handleUpdate(commandUpdate('/ping', { chatId: userId, userId }));

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'ping' }));
  });
});

describe('TelegramBot — BotFather command menu gating (registeredCommands)', () => {
  it('excludes monitor_here from the menu on a non-supervisor bot', () => {
    const { tgBot } = buildTelegramBot(false, 111);
    const commands = (tgBot as unknown as { registeredCommands: () => Array<{ command: string }> }).registeredCommands();
    expect(commands.some((c) => c.command === 'monitor_here')).toBe(false);
  });

  it('includes monitor_here in the menu on the supervisor bot', () => {
    const { tgBot } = buildTelegramBot(true, 111);
    const commands = (tgBot as unknown as { registeredCommands: () => Array<{ command: string }> }).registeredCommands();
    expect(commands.some((c) => c.command === 'monitor_here')).toBe(true);
  });
});
