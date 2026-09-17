// ── Conversation monitor ──
//
// Mirrors every monitored agent's conversation (minus owner-originated turns) into a Telegram
// destination as it happens, so the owner has oversight of what agents do at colleagues'
// request — with particular attention to destructive actions. See
// work/agent-conversation-monitor/PLAN.md for the full design and the 11 acceptance criteria
// this module (plus its bridge.ts wiring) needs to satisfy.
//
// Capture is event-driven throughout: every flush happens in direct response to a bridge/CC
// event (inbound message, assistant message_stop, tool_result, turn end) — never on a
// setInterval/setTimeout batching clock. The one timer-shaped thing here is `sleep()` inside
// the Telegram 429 retry path, which waits exactly the server-dictated `retry_after` before
// resuming a specific queued send — that is API-compliance data driven by the response itself,
// the same pattern StreamAccumulator already uses in streaming.ts, not a batching heuristic.
//
// Failure isolation is a hard requirement: every public method here catches its own errors and
// never throws into the caller, and every Telegram send is fire-and-forget from the bridge's
// point of view — a mirror failure is logged and dropped, never surfaced to the monitored
// conversation and never allowed to delay the agent's reply to its actual recipient.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AssistantMessage, ResultEvent, ToolResultEvent } from './cc-protocol.js';
import { updateConfig, type MonitorConfig } from './config.js';
import { redactSecrets } from './monitor-redact.js';
import { isDestructiveToolCall } from './monitor-destructive.js';

// ── Public types ──

export interface MonitorSenderBot {
  sendText(chatId: number | string, text: string, parseMode?: string, silent?: boolean, threadId?: number): Promise<number>;
  createForumTopic(chatId: number | string, name: string): Promise<number>;
}

export interface MonitorLogger {
  info?: (obj: unknown, msg?: string) => void;
  warn?: (obj: unknown, msg?: string) => void;
  error?: (obj: unknown, msg?: string) => void;
  debug?: (obj: unknown, msg?: string) => void;
}

export interface TelegramSenderIdentity {
  userId: string;
  userName?: string;
  userHandle?: string;
  chatId: number;
  isGroup: boolean;
  chatTitle?: string;
}

export interface InboundContent {
  kind: 'text' | 'photo' | 'document' | 'voice' | 'audio' | 'video_note' | 'video';
  text: string;
  fileName?: string;
}

/** Where an originating human, if any, can be traced back to for a given source agent's
 *  current turn. Single-hop only — see resolveOriginHuman(). */
export type OriginHuman = { userId: string; userName?: string; userHandle?: string } | 'unknown';

export type TurnOrigin =
  | ({ kind: 'telegram' } & TelegramSenderIdentity)
  | { kind: 'tgcc_send'; fromAgentId: string; originHuman: OriginHuman }
  | { kind: 'cron' | 'ralph' | 'supervisor' | 'cli' };

export interface ConversationMonitorOptions {
  /** Returns the current monitor config, or undefined when the feature is off. Read fresh on
   *  every call so config hot-reload takes effect without needing to reconstruct the monitor. */
  getConfig: () => MonitorConfig | undefined;
  /** Returns the bot that should post mirror messages (the native supervisor's bot), or null
   *  if unavailable (e.g. mid hot-reload). Read fresh on every send. */
  getSenderBot: () => MonitorSenderBot | null;
  logger: MonitorLogger;
  /** Where per-agent forum topic ids are persisted. Default: ~/.tgcc/monitor-topics.json.
   *  Override in tests to avoid touching the real file. */
  persistPath?: string;
  /** Writes the resolved chat id back to config (used by /monitor_here). Default: real
   *  ~/.tgcc/config.json via updateConfig(). Override in tests. */
  writeConfigChatId?: (chatId: number) => void;
}

// ── Rendering helpers ──

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Truncate to maxChars, appending "… N more lines" (counting the lines dropped) when cut. */
function truncateForDisplay(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const totalLines = text.split('\n').length;
  const cutLines = cut.split('\n').length;
  const moreLines = Math.max(totalLines - cutLines, 1);
  return `${cut}\n… ${moreLines} more lines`;
}

function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recipientLabel(origin: TurnOrigin | undefined): string {
  if (!origin) return 'unknown';
  if (origin.kind === 'telegram') return origin.userName || origin.userHandle || origin.userId;
  if (origin.kind === 'tgcc_send') return origin.fromAgentId;
  return origin.kind;
}

function humanLabel(human: OriginHuman): string {
  if (human === 'unknown') return 'unknown';
  return human.userName || human.userHandle || human.userId;
}

function renderInboundTelegram(identity: TelegramSenderIdentity, agentId: string, content: InboundContent): string {
  const name = escapeHtml(identity.userName || identity.userId);
  const handle = identity.userHandle ? ` (@${escapeHtml(identity.userHandle)})` : '';
  const where = identity.isGroup
    ? `group &#8220;${escapeHtml(identity.chatTitle || String(identity.chatId))}&#8221;`
    : 'DM';
  const header = `👤 <b>${name}</b>${handle} · <code>${escapeHtml(identity.userId)}</code> → <b>${escapeHtml(agentId)}</b> · ${where}`;

  let body: string;
  switch (content.kind) {
    case 'photo':
      body = `🖼 photo${content.text ? `: ${escapeHtml(truncateForDisplay(content.text, 500))}` : ''}`;
      break;
    case 'document':
      body = `📄 document: <code>${escapeHtml(content.fileName ?? 'file')}</code>${content.text ? ` — ${escapeHtml(truncateForDisplay(content.text, 500))}` : ''}`;
      break;
    case 'voice':
    case 'audio':
    case 'video_note':
      body = `🎙 ${escapeHtml(content.kind)} (transcribed): ${escapeHtml(truncateForDisplay(redactSecrets(content.text), 2500))}`;
      break;
    case 'video':
      body = `🎬 video${content.text ? `: ${escapeHtml(truncateForDisplay(content.text, 500))}` : ''}`;
      break;
    default:
      body = escapeHtml(truncateForDisplay(redactSecrets(content.text), 2500));
  }
  return `${header}\n${body}`;
}

function renderInboundSystem(agentId: string, origin: Extract<TurnOrigin, { kind: 'cron' | 'ralph' | 'supervisor' | 'cli' }>, text: string): string {
  const emoji = origin.kind === 'cron' ? '⏰' : origin.kind === 'ralph' ? '🐕' : origin.kind === 'cli' ? '⌨️' : '🧭';
  const header = `${emoji} ${escapeHtml(origin.kind)} → <b>${escapeHtml(agentId)}</b>`;
  return `${header}\n${escapeHtml(truncateForDisplay(redactSecrets(text), 2000))}`;
}

function renderTgccSend(agentId: string, origin: Extract<TurnOrigin, { kind: 'tgcc_send' }>, text: string): string {
  const who = escapeHtml(humanLabel(origin.originHuman));
  const header = `🔁 <b>${escapeHtml(origin.fromAgentId)}</b> → <b>${escapeHtml(agentId)}</b> · tgcc_send (origin: ${who})`;
  return `${header}\n${escapeHtml(truncateForDisplay(redactSecrets(text), 2000))}`;
}

function renderThinking(agentId: string, text: string): string {
  const body = escapeHtml(truncateForDisplay(redactSecrets(text), 3000));
  return `<blockquote expandable>💭 <b>${escapeHtml(agentId)}</b>\n${body}</blockquote>`;
}

function renderAssistantText(agentId: string, text: string, isFinal: boolean, recipient: string): string {
  const body = escapeHtml(truncateForDisplay(redactSecrets(text), 3000));
  const header = isFinal
    ? `🤖 <b>${escapeHtml(agentId)}</b> → ${escapeHtml(recipient)}`
    : `💬 <b>${escapeHtml(agentId)}</b>`;
  return `${header}\n${body}`;
}

function renderToolCall(agentId: string, toolName: string, input: Record<string, unknown>): string {
  const destructive = isDestructiveToolCall(toolName, input);
  const prefix = destructive ? '⚠️ ' : '';
  const inputStr = redactSecrets(safeStringify(input));
  const body = escapeHtml(truncateForDisplay(inputStr, 1500));
  const header = `${prefix}🔧 <b>${escapeHtml(agentId)}</b> · <code>${escapeHtml(toolName)}</code>`;
  return `${header}\n<blockquote expandable>${body}</blockquote>`;
}

function renderToolResult(event: ToolResultEvent): string {
  const name = event.tool_use_result?.name ?? 'tool';
  const isErr = event.is_error === true;
  const prefix = isErr ? '❌' : '↩️';
  const contentStr = typeof event.content === 'string' ? event.content : safeStringify(event.content);
  const body = escapeHtml(truncateForDisplay(redactSecrets(contentStr), 2000));
  const header = `${prefix} <code>${escapeHtml(name)}</code>`;
  return `${header}\n<blockquote expandable>${body}</blockquote>`;
}

/** Split a set of already-rendered HTML blocks into ≤maxLen-char Telegram messages,
 *  never splitting a block itself (each block should already be well under the limit). */
function splitForTelegram(blocks: string[], maxLen = 3500): string[] {
  const messages: string[] = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length > maxLen && current) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  return messages;
}

function isOriginExcluded(origin: TurnOrigin | undefined, excludeUsers: string[]): boolean {
  if (!origin) return false; // no known origin — fail open toward visibility, not silence
  if (origin.kind === 'telegram') return excludeUsers.includes(origin.userId);
  if (origin.kind === 'tgcc_send') return origin.originHuman !== 'unknown' && excludeUsers.includes(origin.originHuman.userId);
  return false; // cron/ralph/supervisor/cli have no human origin — never excluded
}

// ── ConversationMonitor ──

export class ConversationMonitor {
  private readonly opts: ConversationMonitorOptions;
  private readonly persistPath: string;

  /** `${agentId}:${chatId}` → the origin of that chat's current/most recent turn. */
  private turnOrigins = new Map<string, TurnOrigin>();
  /** agentId → the chatId its current/most recent turn used (for single-hop tgcc_send tracing). */
  private agentPrimaryChat = new Map<string, number>();
  /** `${agentId}:${chatId}` → rendered blocks waiting for the next flush point. */
  private pendingLines = new Map<string, string[]>();
  /** agentId → tail of its outbound send chain (ordering + serialized 429 backoff). */
  private sendChains = new Map<string, Promise<void>>();
  /** agentId → message_thread_id, persisted to disk. */
  private topics: Record<string, number> = {};
  /** agentId → in-flight topic-creation promise, to de-dup concurrent creators. */
  private topicCreations = new Map<string, Promise<number | undefined>>();

  constructor(opts: ConversationMonitorOptions) {
    this.opts = opts;
    this.persistPath = opts.persistPath ?? join(homedir(), '.tgcc', 'monitor-topics.json');
    this.loadTopics();
  }

  // ── Persistence ──

  private loadTopics(): void {
    try {
      if (existsSync(this.persistPath)) {
        const raw = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
        if (raw && typeof raw === 'object') {
          this.topics = Object.fromEntries(
            Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'number'),
          ) as Record<string, number>;
        }
      }
    } catch (err) {
      this.opts.logger.warn?.({ err }, 'ConversationMonitor: failed to load persisted topics — starting fresh');
      this.topics = {};
    }
  }

  private saveTopics(): void {
    try {
      const dir = dirname(this.persistPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(this.topics, null, 2));
    } catch (err) {
      this.opts.logger.warn?.({ err }, 'ConversationMonitor: failed to persist topics');
    }
  }

  // ── Helpers ──

  private key(agentId: string, chatId: number): string {
    return `${agentId}:${chatId}`;
  }

  private isMonitoredAgent(agentId: string): boolean {
    const cfg = this.opts.getConfig();
    return !!cfg && cfg.agents.includes(agentId);
  }

  private appendPending(key: string, lines: string[]): void {
    const arr = this.pendingLines.get(key) ?? [];
    arr.push(...lines);
    this.pendingLines.set(key, arr);
  }

  private takePending(key: string): string[] {
    const arr = this.pendingLines.get(key) ?? [];
    this.pendingLines.delete(key);
    return arr;
  }

  private flush(agentId: string, key: string): void {
    const lines = this.takePending(key);
    if (lines.length === 0) return;
    for (const message of splitForTelegram(lines)) {
      this.enqueueSend(agentId, message);
    }
  }

  // ── Inbound capture ──

  /** Record + mirror an inbound Telegram message (DM, group, or transcribed voice/audio/video).
   *  Always updates turn-origin bookkeeping, even when the sender is excluded, so subsequent
   *  assistant/tool_result/result events for this turn are correctly suppressed too. */
  recordInboundTelegram(agentId: string, identity: TelegramSenderIdentity, content: InboundContent): void {
    try {
      if (!this.isMonitoredAgent(agentId)) return;
      const cfg = this.opts.getConfig();
      if (!cfg) return;
      const key = this.key(agentId, identity.chatId);
      const origin: TurnOrigin = { kind: 'telegram', ...identity };
      this.turnOrigins.set(key, origin);
      this.agentPrimaryChat.set(agentId, identity.chatId);
      if (isOriginExcluded(origin, cfg.excludeUsers)) return;
      this.appendPending(key, [renderInboundTelegram(identity, agentId, content)]);
      this.flush(agentId, key);
    } catch (err) {
      this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor.recordInboundTelegram failed — dropped');
    }
  }

  /** Record + mirror a non-Telegram-originated turn (tgcc_send, cron, ralph, supervisor nudge,
   *  or a CLI-attached send). Same turn-origin bookkeeping semantics as recordInboundTelegram. */
  recordInboundSystem(
    agentId: string,
    chatId: number,
    origin: Extract<TurnOrigin, { kind: 'tgcc_send' | 'cron' | 'ralph' | 'supervisor' | 'cli' }>,
    text: string,
  ): void {
    try {
      if (!this.isMonitoredAgent(agentId)) return;
      const cfg = this.opts.getConfig();
      if (!cfg) return;
      const key = this.key(agentId, chatId);
      this.turnOrigins.set(key, origin);
      this.agentPrimaryChat.set(agentId, chatId);
      if (isOriginExcluded(origin, cfg.excludeUsers)) return;
      const line = origin.kind === 'tgcc_send' ? renderTgccSend(agentId, origin, text) : renderInboundSystem(agentId, origin, text);
      this.appendPending(key, [line]);
      this.flush(agentId, key);
    } catch (err) {
      this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor.recordInboundSystem failed — dropped');
    }
  }

  /** Resolve the human who started `sourceAgentId`'s current turn, for tagging a tgcc_send this
   *  agent originates. Single-hop only: if that turn is itself agent-originated (another
   *  tgcc_send, cron, etc.) this returns 'unknown' rather than chasing the chain further — an
   *  explicit "origin unknown" is itself information, per the plan's design decision. */
  resolveOriginHuman(sourceAgentId: string): OriginHuman {
    try {
      const chatId = this.agentPrimaryChat.get(sourceAgentId);
      if (chatId == null) return 'unknown';
      const origin = this.turnOrigins.get(this.key(sourceAgentId, chatId));
      if (origin?.kind === 'telegram') {
        return { userId: origin.userId, userName: origin.userName, userHandle: origin.userHandle };
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  // ── Stream capture (called from the same proc.on('assistant'|'tool_result'|'result')
  //     closures bridge.ts already registers per chat in spawnCCProcess — agentId/chatId are
  //     already in scope there, so no extra plumbing is needed to reach this per-chat state). ──

  recordAssistant(agentId: string, chatId: number, message: AssistantMessage): void {
    try {
      if (!this.isMonitoredAgent(agentId)) return;
      const cfg = this.opts.getConfig();
      if (!cfg) return;
      const key = this.key(agentId, chatId);
      const origin = this.turnOrigins.get(key);
      if (isOriginExcluded(origin, cfg.excludeUsers)) return;

      // stop_reason !== 'tool_use' means CC won't call more tools after this message, so any
      // text block here is the turn's actual reply to its recipient — tag it as such.
      const isFinal = message.message.stop_reason !== 'tool_use';
      const recipient = recipientLabel(origin);
      const lines: string[] = [];
      for (const block of message.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          lines.push(renderThinking(agentId, block.thinking));
        } else if (block.type === 'text' && block.text) {
          lines.push(renderAssistantText(agentId, block.text, isFinal, recipient));
        } else if (block.type === 'tool_use') {
          lines.push(renderToolCall(agentId, block.name, block.input ?? {}));
        }
        // redacted_thinking / signature blocks carry no user-facing content — skip.
      }
      if (lines.length === 0) return;
      this.appendPending(key, lines);
      // Flush per assistant message_stop (see module header) — this is also what makes a
      // destructive tool call visible immediately rather than waiting for turn end: there is no
      // coarser buffering boundary than "one complete assistant message" in this design.
      this.flush(agentId, key);
    } catch (err) {
      this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor.recordAssistant failed — dropped');
    }
  }

  recordToolResult(agentId: string, chatId: number, event: ToolResultEvent): void {
    try {
      if (!this.isMonitoredAgent(agentId)) return;
      const cfg = this.opts.getConfig();
      if (!cfg) return;
      const key = this.key(agentId, chatId);
      const origin = this.turnOrigins.get(key);
      if (isOriginExcluded(origin, cfg.excludeUsers)) return;
      // Buffered, not flushed here — piggybacks on the next assistant flush or turn end, so a
      // tool_use immediately followed by its result doesn't produce two separate TG messages.
      this.appendPending(key, [renderToolResult(event)]);
    } catch (err) {
      this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor.recordToolResult failed — dropped');
    }
  }

  recordTurnEnd(agentId: string, chatId: number, event: ResultEvent): void {
    try {
      if (!this.isMonitoredAgent(agentId)) return;
      const cfg = this.opts.getConfig();
      if (!cfg) return;
      const key = this.key(agentId, chatId);
      const origin = this.turnOrigins.get(key);
      if (isOriginExcluded(origin, cfg.excludeUsers)) return;
      if (event.is_error) {
        const recipient = recipientLabel(origin);
        const resultText = event.result ? `: ${escapeHtml(truncateForDisplay(redactSecrets(event.result), 500))}` : '';
        this.appendPending(key, [`🤖 <b>${escapeHtml(agentId)}</b> → ${escapeHtml(recipient)} · ⚠️ turn ended with error${resultText}`]);
      }
      this.flush(agentId, key);
    } catch (err) {
      this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor.recordTurnEnd failed — dropped');
    }
  }

  // ── /monitor_here ──

  /** Persist the destination chat id (e.g. from /monitor_here run inside the target group). */
  registerHere(chatId: number): void {
    try {
      const writer = this.opts.writeConfigChatId ?? ConversationMonitor.defaultWriteConfigChatId;
      writer(chatId);
    } catch (err) {
      this.opts.logger.error?.({ err }, 'ConversationMonitor.registerHere failed');
    }
  }

  private static defaultWriteConfigChatId(chatId: number): void {
    updateConfig((cfg) => {
      const monitor = (cfg.monitor && typeof cfg.monitor === 'object' ? cfg.monitor : {}) as Record<string, unknown>;
      monitor.chatId = chatId;
      if (!Array.isArray(monitor.agents)) monitor.agents = [];
      if (!Array.isArray(monitor.excludeUsers)) monitor.excludeUsers = [];
      if (typeof monitor.topicPerAgent !== 'boolean') monitor.topicPerAgent = true;
      cfg.monitor = monitor;
    });
  }

  // ── Outbound send pipeline ──

  /** Queue one already-rendered HTML message for delivery, preserving per-agent order and
   *  honoring Telegram 429s. Never throws — failures are logged and dropped. This chain drains
   *  eagerly as each send settles; it never waits on the monitored agent's own state (idle or
   *  otherwise), so it isn't the kind of cross-agent queue the repo's "no queues" rule targets. */
  private enqueueSend(agentId: string, html: string): void {
    const prev = this.sendChains.get(agentId) ?? Promise.resolve();
    const next = prev
      .then(() => this.doSend(agentId, html))
      .catch((err) => {
        this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor: mirror send failed — dropped');
      });
    this.sendChains.set(agentId, next);
  }

  private async doSend(agentId: string, html: string, attempt = 0): Promise<void> {
    const cfg = this.opts.getConfig();
    if (!cfg) return;
    const bot = this.opts.getSenderBot();
    if (!bot) {
      this.opts.logger.warn?.({ agentId }, 'ConversationMonitor: no sender bot available — dropping mirror message');
      return;
    }
    const threadId = cfg.topicPerAgent ? await this.resolveTopic(agentId, bot, cfg.chatId) : undefined;
    try {
      await bot.sendText(cfg.chatId, html, 'HTML', true, threadId);
    } catch (err: unknown) {
      const errorCode = err && typeof err === 'object' && 'error_code' in err ? (err as { error_code: number }).error_code : 0;
      if (errorCode === 429 && attempt < 5) {
        const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5;
        await sleep(retryAfter * 1000);
        return this.doSend(agentId, html, attempt + 1);
      }
      this.opts.logger.warn?.({ err, agentId, errorCode }, 'ConversationMonitor: send failed — dropping mirror message');
    }
  }

  private async resolveTopic(agentId: string, bot: MonitorSenderBot, chatId: number): Promise<number | undefined> {
    const existing = this.topics[agentId];
    if (existing) return existing;

    let pending = this.topicCreations.get(agentId);
    if (!pending) {
      pending = (async () => {
        try {
          const threadId = await bot.createForumTopic(chatId, agentId);
          this.topics[agentId] = threadId;
          this.saveTopics();
          return threadId;
        } catch (err) {
          this.opts.logger.warn?.({ err, agentId }, 'ConversationMonitor: failed to create forum topic — sending without a thread');
          return undefined;
        } finally {
          this.topicCreations.delete(agentId);
        }
      })();
      this.topicCreations.set(agentId, pending);
    }
    return pending;
  }
}
