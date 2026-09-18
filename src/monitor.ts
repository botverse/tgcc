// ── Conversation monitor ──
//
// Mirrors every monitored agent's conversation (minus owner-originated turns) into a Telegram
// destination as it happens, so the owner has oversight of what agents do at colleagues'
// request — with particular attention to destructive actions. See
// work/agent-conversation-monitor/PLAN.md for the full design and the acceptance criteria this
// module (plus its bridge.ts wiring) needs to satisfy.
//
// Capture is event-driven throughout: every flush happens in direct response to a bridge/CC
// event (inbound message, assistant message_stop, tool_result, turn end) — never on a
// setInterval/setTimeout batching clock. The one timer-shaped thing here is `sleep()` inside
// the Telegram 429 retry path, which waits exactly the server-dictated `retry_after` before
// resuming a specific queued send — that is API-compliance data driven by the response itself,
// the same pattern StreamAccumulator already uses in streaming.ts, not a batching heuristic.
//
// Delivery is serialized per DESTINATION CHAT, not per agent: Telegram throttles a bot to
// roughly 20 messages/minute per chat, and forum topics share that one chat's limit, so one
// pump loop drains a single shared outbound backlog (keyed by agent/topic) — see "Outbound
// delivery pipeline" below for why and how.
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
  /** Where per-(destination chat, agent) forum topic ids are persisted. Default:
   *  ~/.tgcc/monitor-topics.json. Override in tests to avoid touching the real file. */
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

function renderToolCall(agentId: string, toolName: string, input: Record<string, unknown>, destructive: boolean): string {
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

function isOriginExcluded(origin: TurnOrigin | undefined, excludeUsers: string[]): boolean {
  if (!origin) return false; // no known origin — fail open toward visibility, not silence
  if (origin.kind === 'telegram') return excludeUsers.includes(origin.userId);
  if (origin.kind === 'tgcc_send') return origin.originHuman !== 'unknown' && excludeUsers.includes(origin.originHuman.userId);
  return false; // cron/ralph/supervisor/cli have no human origin — never excluded
}

// ── Outbound backlog block ──
//
// `critical` blocks (destructive tool calls, inbound human messages, tgcc_send origins, and an
// agent's final reply) are never collapsed and are packed ahead of routine content on every
// send, so a ⚠️ is never stuck behind a backlog. `collapseLabel` groups routine blocks in the
// "… N routine events omitted" summary when a per-agent backlog exceeds its cap.
interface PendingBlock {
  html: string;
  critical: boolean;
  collapseLabel: string;
}

// ── ConversationMonitor ──

export class ConversationMonitor {
  private static readonly MAX_MESSAGE_LEN = 3500;
  /** Max routine (non-critical) blocks retained per agent's outbound backlog before the oldest
   *  are collapsed into one summary line. Bounds memory under sustained high-volume turns
   *  (e.g. a 100-tool-call loop) without ever dropping critical content. */
  private static readonly ROUTINE_BACKLOG_CAP = 50;

  private readonly opts: ConversationMonitorOptions;
  private readonly persistPath: string;

  /** `${agentId}:${chatId}` → the origin of that chat's current/most recent turn. */
  private turnOrigins = new Map<string, TurnOrigin>();
  /** agentId → the chatId its current/most recent turn used (for single-hop tgcc_send tracing). */
  private agentPrimaryChat = new Map<string, number>();
  /** `${agentId}:${chatId}` → rendered blocks waiting for the next turn-boundary flush point
   *  (assistant message_stop / turn end) — see recordAssistant/recordToolResult/recordTurnEnd. */
  private pendingLines = new Map<string, PendingBlock[]>();

  /** agentId → blocks flushed from a turn boundary but not yet delivered to Telegram. This is
   *  the layer the pump loop drains — see "Outbound delivery pipeline" below. */
  private backlogs = new Map<string, PendingBlock[]>();
  /** True while the single pump loop for the destination chat is actively draining backlogs. */
  private pumpRunning = false;
  /** Round-robins which agent's backlog gets the next send when several have pending content. */
  private rotationCursor = 0;

  /** `${chatId}:${agentId}` → message_thread_id, persisted to disk. Keyed by destination chat
   *  id (not just agentId) so that if the destination changes, stale thread ids from the OLD
   *  chat are never reused against the NEW one — every agent's topic is created fresh there. */
  private topics: Record<string, number> = {};
  /** `${chatId}:${agentId}` → in-flight topic-creation promise, to de-dup concurrent creators. */
  private topicCreations = new Map<string, Promise<number | undefined>>();
  /** True once topic creation has failed for the current destination chat (Topics disabled, or
   *  the bot lacks can_manage_topics) — suppresses further creation attempts and warnings for
   *  agents that don't already have a topic, so the operator sees the warning once, not per
   *  message. Reset whenever the destination chat changes (registerHere). */
  private topicsUnavailableWarned = false;

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

  private topicKey(destinationChatId: number, agentId: string): string {
    return `${destinationChatId}:${agentId}`;
  }

  private isMonitoredAgent(agentId: string): boolean {
    const cfg = this.opts.getConfig();
    return !!cfg && cfg.agents.includes(agentId);
  }

  private appendPending(key: string, blocks: PendingBlock[]): void {
    const arr = this.pendingLines.get(key) ?? [];
    arr.push(...blocks);
    this.pendingLines.set(key, arr);
  }

  private takePending(key: string): PendingBlock[] {
    const arr = this.pendingLines.get(key) ?? [];
    this.pendingLines.delete(key);
    return arr;
  }

  /** Move a turn boundary's buffered blocks into the agent's outbound backlog and make sure the
   *  pump loop is running to drain it. This is NOT itself a Telegram send — see "Outbound
   *  delivery pipeline" for why sending is decoupled from turn boundaries. */
  private flush(agentId: string, key: string): void {
    const blocks = this.takePending(key);
    if (blocks.length === 0) return;
    this.pushToBacklog(agentId, blocks);
    this.schedulePump();
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
      this.appendPending(key, [{ html: renderInboundTelegram(identity, agentId, content), critical: true, collapseLabel: 'inbound' }]);
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
      const html = origin.kind === 'tgcc_send' ? renderTgccSend(agentId, origin, text) : renderInboundSystem(agentId, origin, text);
      this.appendPending(key, [{ html, critical: true, collapseLabel: origin.kind }]);
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
      // text block here is the turn's actual reply to its recipient — tag it as such, and treat
      // it as critical (never collapsed, packed first) like other "who asked for what" content.
      const isFinal = message.message.stop_reason !== 'tool_use';
      const recipient = recipientLabel(origin);
      const blocks: PendingBlock[] = [];
      for (const block of message.message.content) {
        if (block.type === 'thinking' && block.thinking) {
          blocks.push({ html: renderThinking(agentId, block.thinking), critical: false, collapseLabel: 'thinking' });
        } else if (block.type === 'text' && block.text) {
          blocks.push({
            html: renderAssistantText(agentId, block.text, isFinal, recipient),
            critical: isFinal,
            collapseLabel: isFinal ? 'reply' : 'text',
          });
        } else if (block.type === 'tool_use') {
          const input = block.input ?? {};
          const destructive = isDestructiveToolCall(block.name, input);
          blocks.push({ html: renderToolCall(agentId, block.name, input, destructive), critical: destructive, collapseLabel: block.name });
        }
        // redacted_thinking / signature blocks carry no user-facing content — skip.
      }
      if (blocks.length === 0) return;
      this.appendPending(key, blocks);
      // Flush per assistant message_stop (see module header): the turn-boundary buffer moves
      // into the outbound backlog here, at the finest granularity this design has. Whether that
      // becomes its own Telegram message or gets packed with other pending content is decided
      // by the pump loop, not here — see "Outbound delivery pipeline".
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
      // Routine (collapsible) — a tool result on its own doesn't carry "who asked for what".
      const toolName = event.tool_use_result?.name ?? 'tool';
      this.appendPending(key, [{ html: renderToolResult(event), critical: false, collapseLabel: `${toolName} result` }]);
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
        const html = `🤖 <b>${escapeHtml(agentId)}</b> → ${escapeHtml(recipient)} · ⚠️ turn ended with error${resultText}`;
        this.appendPending(key, [{ html, critical: true, collapseLabel: 'reply' }]);
      }
      this.flush(agentId, key);
    } catch (err) {
      this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor.recordTurnEnd failed — dropped');
    }
  }

  // ── /monitor_here ──

  /** Persist the destination chat id (e.g. from /monitor_here run inside the target group).
   *  Authorization (supervisor bot + owner user id) is the caller's responsibility — see
   *  bridge.ts's monitor_here handler; this method just performs the change and makes sure it's
   *  never silent: the previous destination (if any, and if it's actually different) gets
   *  notified that it no longer receives mirrored conversations. */
  registerHere(chatId: number, changedByUserId: string): void {
    try {
      const previousChatId = this.opts.getConfig()?.chatId;
      const writer = this.opts.writeConfigChatId ?? ConversationMonitor.defaultWriteConfigChatId;
      writer(chatId);
      // A new destination might support Topics even if the old one didn't (or vice versa) —
      // don't carry a stale "don't bother trying" flag across a destination change.
      this.topicsUnavailableWarned = false;
      this.opts.logger.info?.({ chatId, previousChatId, changedByUserId }, 'ConversationMonitor: destination registered via /monitor_here');
      if (previousChatId != null && previousChatId !== chatId) {
        this.notifyDestinationChanged(previousChatId, changedByUserId);
      }
    } catch (err) {
      this.opts.logger.error?.({ err }, 'ConversationMonitor.registerHere failed');
    }
  }

  /** Tell the OLD destination chat that it's been replaced, so losing oversight is never silent
   *  even to whoever was watching the previous chat. Deliberately doesn't name the new chat id
   *  in the message — the old chat may not be trusted with that. Best-effort, fire-and-forget. */
  private notifyDestinationChanged(previousChatId: number, changedByUserId: string): void {
    const bot = this.opts.getSenderBot();
    if (!bot) return;
    const text = `⚠️ The conversation monitor destination was changed to a different chat by user <code>${escapeHtml(changedByUserId)}</code>. This chat no longer receives mirrored conversations.`;
    bot.sendText(previousChatId, text, 'HTML', false).catch((err) => {
      this.opts.logger.warn?.({ err, previousChatId }, 'ConversationMonitor: failed to notify previous destination of change');
    });
  }

  private static defaultWriteConfigChatId(chatId: number): void {
    updateConfig((cfg) => {
      const monitor = (cfg.monitor && typeof cfg.monitor === 'object' ? cfg.monitor : {}) as Record<string, unknown>;
      monitor.chatId = chatId;
      if (!Array.isArray(monitor.agents)) monitor.agents = [];
      if (!Array.isArray(monitor.excludeUsers)) monitor.excludeUsers = [];
      if (typeof monitor.topicPerAgent !== 'boolean') monitor.topicPerAgent = true;
      // ownerUserId is deliberately left untouched — the bridge-level /monitor_here handler
      // already refuses to call registerHere at all unless it's set, so it must already be
      // present in the on-disk config by the time this runs.
      cfg.monitor = monitor;
    });
  }

  // ── Outbound delivery pipeline ──
  //
  // Telegram throttles a bot to roughly 20 messages/minute PER CHAT, and every monitored agent
  // posts into the same destination chat (forum topics share that chat's limit) — so delivery
  // must be serialized per destination chat, not per agent, or separate per-agent send chains
  // would fight over one limit and multiply 429s. This is a single pump loop: while a send is
  // in flight, new blocks simply accumulate in `backlogs`; the send's completion is the event
  // that triggers picking the next thing to send, packing as much of one agent's pending
  // content as fits into one message (Telegram messages target one thread, so a pack never
  // mixes agents). The result is that Telegram message count follows the rate limit (plus how
  // much fits per message) rather than the raw event count, while a ⚠️/critical block always
  // jumps to the front of whichever agent's pack is chosen next — see packBacklog/selectNext.

  private pushToBacklog(agentId: string, blocks: PendingBlock[]): void {
    const arr = this.backlogs.get(agentId) ?? [];
    arr.push(...blocks);
    this.backlogs.set(agentId, arr);
    this.enforceBacklogCap(agentId, arr);
  }

  /** Collapse the oldest ROUTINE blocks in an agent's backlog once it exceeds
   *  ROUTINE_BACKLOG_CAP, into one summary line grouped by collapseLabel (e.g. "Read ×20, Grep
   *  ×12, Bash ×5"). Critical blocks are never touched by this, regardless of position or age. */
  private enforceBacklogCap(agentId: string, blocks: PendingBlock[]): void {
    const routineCount = blocks.reduce((n, b) => (b.critical ? n : n + 1), 0);
    let toCollapse = routineCount - ConversationMonitor.ROUTINE_BACKLOG_CAP;
    if (toCollapse <= 0) return;

    const counts = new Map<string, number>();
    const kept: PendingBlock[] = [];
    let collapsedTotal = 0;
    let summaryInsertIndex = -1;
    for (const block of blocks) {
      if (!block.critical && toCollapse > 0) {
        counts.set(block.collapseLabel, (counts.get(block.collapseLabel) ?? 0) + 1);
        collapsedTotal++;
        toCollapse--;
        if (summaryInsertIndex === -1) summaryInsertIndex = kept.length;
        continue;
      }
      kept.push(block);
    }
    const summaryParts = [...counts.entries()].map(([label, n]) => `${escapeHtml(label)} ×${n}`).join(', ');
    const summaryBlock: PendingBlock = {
      html: `<i>… ${collapsedTotal} routine events omitted: ${summaryParts}</i>`,
      critical: false,
      collapseLabel: 'summary',
    };
    kept.splice(Math.max(summaryInsertIndex, 0), 0, summaryBlock);
    this.backlogs.set(agentId, kept);
    this.opts.logger.debug?.({ agentId, collapsedTotal }, 'ConversationMonitor: collapsed routine backlog past cap');
  }

  /** Start the pump loop if it isn't already running. Idempotent — if a loop is already
   *  draining backlogs, it will pick up whatever was just pushed on its next iteration once the
   *  current send completes, so calling this again is a no-op rather than a second loop. */
  private schedulePump(): void {
    if (this.pumpRunning) return;
    this.pumpRunning = true;
    void this.pumpLoop();
  }

  private async pumpLoop(): Promise<void> {
    try {
      for (;;) {
        const next = this.selectNextToSend();
        if (!next) break;
        await this.deliver(next.agentId, next.html);
      }
    } finally {
      this.pumpRunning = false;
    }
  }

  /** Pick which agent's backlog to pack into the next message. Agents with at least one
   *  critical block pending take priority over agents with only routine content, so a ⚠️ (or an
   *  inbound message, tgcc_send origin, or reply) is never stuck behind another agent's routine
   *  backlog. Rotates among tied candidates for fairness across busy agents. */
  private selectNextToSend(): { agentId: string; html: string } | null {
    const withCritical: string[] = [];
    const withAny: string[] = [];
    for (const [agentId, blocks] of this.backlogs) {
      if (blocks.length === 0) continue;
      withAny.push(agentId);
      if (blocks.some((b) => b.critical)) withCritical.push(agentId);
    }
    const candidates = withCritical.length > 0 ? withCritical : withAny;
    if (candidates.length === 0) return null;
    const agentId = candidates[this.rotationCursor % candidates.length];
    this.rotationCursor++;
    const html = this.packBacklog(agentId);
    if (html == null) return null;
    return { agentId, html };
  }

  /** Pack as much of one agent's pending backlog as fits into a single ≤MAX_MESSAGE_LEN-char
   *  Telegram message, removing the packed blocks from the backlog. Critical blocks are always
   *  ordered first (see class header); a lone block that exceeds the limit on its own is sent
   *  alone rather than stalling the pump forever. */
  private packBacklog(agentId: string): string | null {
    const blocks = this.backlogs.get(agentId);
    if (!blocks || blocks.length === 0) return null;

    const critical = blocks.filter((b) => b.critical);
    const routine = blocks.filter((b) => !b.critical);
    const ordered = [...critical, ...routine];

    const packed: PendingBlock[] = [];
    let total = 0;
    for (const block of ordered) {
      const isFirst = packed.length === 0;
      const addition = isFirst ? block.html.length : block.html.length + 2; // +2 for the "\n\n" join
      if (!isFirst && total + addition > ConversationMonitor.MAX_MESSAGE_LEN) break;
      packed.push(block);
      total += addition;
      if (isFirst && addition > ConversationMonitor.MAX_MESSAGE_LEN) break; // oversized alone — send it, don't try to append more
    }

    const packedSet = new Set(packed);
    const remaining = blocks.filter((b) => !packedSet.has(b));
    if (remaining.length === 0) this.backlogs.delete(agentId);
    else this.backlogs.set(agentId, remaining);

    return packed.map((b) => b.html).join('\n\n');
  }

  /** Deliver one already-packed message, honoring Telegram 429s by waiting exactly the
   *  server-dictated retry_after and trying again (same idiom as streaming.ts). Never throws —
   *  this is awaited directly inside pumpLoop's loop, so an uncaught error here would stall the
   *  whole pump for the rest of the process lifetime; every failure is logged and the message
   *  is dropped instead. */
  private async deliver(agentId: string, html: string, attempt = 0): Promise<void> {
    try {
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
          return this.deliver(agentId, html, attempt + 1);
        }
        this.opts.logger.warn?.({ err, agentId, errorCode }, 'ConversationMonitor: send failed — dropping mirror message');
      }
    } catch (err) {
      this.opts.logger.error?.({ err, agentId }, 'ConversationMonitor: unexpected error delivering mirror message — dropped');
    }
  }

  private async resolveTopic(agentId: string, bot: MonitorSenderBot, chatId: number): Promise<number | undefined> {
    const tKey = this.topicKey(chatId, agentId);
    const existing = this.topics[tKey];
    if (existing) return existing;
    // Topics already established as unavailable for this destination — don't retry per message,
    // and don't warn again (see topicsUnavailableWarned).
    if (this.topicsUnavailableWarned) return undefined;

    let pending = this.topicCreations.get(tKey);
    if (!pending) {
      pending = (async () => {
        try {
          const threadId = await bot.createForumTopic(chatId, agentId);
          this.topics[tKey] = threadId;
          this.saveTopics();
          return threadId;
        } catch (err) {
          if (!this.topicsUnavailableWarned) {
            this.topicsUnavailableWarned = true;
            this.opts.logger.warn?.(
              { err, chatId },
              'ConversationMonitor: forum topics unavailable in the destination chat (Topics disabled, or bot lacks can_manage_topics?) — falling back to posting without a thread',
            );
          }
          return undefined;
        } finally {
          this.topicCreations.delete(tKey);
        }
      })();
      this.topicCreations.set(tKey, pending);
    }
    return pending;
  }
}
