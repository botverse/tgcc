import { readFileSync, watchFile, unwatchFile, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type {
  StreamInnerEvent,
  StreamContentBlockStart,
  StreamContentBlockStop,
  StreamInputJsonDelta,
  StreamTextDelta,
} from './cc-protocol.js';

// ── Types ──

export interface TelegramSender {
  sendMessage(chatId: number | string, text: string, parseMode?: string): Promise<number>;
  editMessage(chatId: number | string, messageId: number, text: string, parseMode?: string): Promise<void>;
  sendPhoto?(chatId: number | string, imageBuffer: Buffer, caption?: string): Promise<number>;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
}

export interface StreamAccumulatorOptions {
  chatId: number | string;
  sender: TelegramSender;
  editIntervalMs?: number;      // min ms between TG edits (default 1000)
  splitThreshold?: number;       // char count to trigger message split (default 4000)
}

// ── HTML safety & conversion ──

/** Escape characters that are special in Telegram HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert markdown-ish text to Telegram-safe HTML.
 * Handles code blocks, inline code, bold, italic, strikethrough, links.
 * Falls back to HTML-escaped plain text for anything it can't convert.
 */
/**
 * Convert a markdown table into Telegram-friendly list format.
 * Tables use `<b>col1</b> — col2 — col3` per data row.
 */
function convertMarkdownTable(tableBlock: string): string {
  const lines = tableBlock.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) return tableBlock;

  const parseRow = (line: string): string[] =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  // Detect separator row (e.g. |---|---|)
  const isSeparator = (line: string) => /^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/.test(line);

  let headerRow: string[] | null = null;
  const dataRows: string[][] = [];

  let i = 0;
  // First non-separator row is header if followed by separator
  if (i < lines.length && !isSeparator(lines[i])) {
    if (i + 1 < lines.length && isSeparator(lines[i + 1])) {
      headerRow = parseRow(lines[i]);
      i += 2; // skip header + separator
    }
  }

  for (; i < lines.length; i++) {
    if (!isSeparator(lines[i])) {
      dataRows.push(parseRow(lines[i]));
    }
  }

  if (dataRows.length === 0) return tableBlock;

  return dataRows.map(cols => {
    if (cols.length === 0) return '';
    const first = `<b>${escapeHtml(cols[0])}</b>`;
    const rest = cols.slice(1).map(c => escapeHtml(c));
    return rest.length > 0 ? `${first} — ${rest.join(' — ')}` : first;
  }).join('\n');
}

export function markdownToHtml(text: string): string {
  // First, extract code blocks to protect them from other conversions
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

  // Convert markdown tables before HTML escaping (tables contain | which is safe)
  const tableBlocks: string[] = [];
  result = result.replace(
    /(?:^|\n)((?:\|[^\n]+\|\s*\n?){2,})/g,
    (_match, table, offset) => {
      // Only treat as table if it has a separator row
      if (/^\|?\s*[-:]+\s*(\|\s*[-:]+\s*)+\|?\s*$/m.test(table)) {
        const idx = tableBlocks.length;
        tableBlocks.push(convertMarkdownTable(table.trim()));
        return `\n\x00TABLE${idx}\x00`;
      }
      return _match;
    },
  );

  // Extract inline code
  const inlineCodes: string[] = [];
  result = result.replace(/`([^`\n]+)`/g, (_match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Escape HTML in remaining text
  result = escapeHtml(result);

  // Convert markdown formatting
  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words for underscore)
  result = result.replace(/(?<!\w)\*([^*\n]+?)\*(?!\w)/g, '<i>$1</i>');
  result = result.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks, inline code, and tables
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)]);
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_match, idx) => inlineCodes[Number(idx)]);
  result = result.replace(/\x00TABLE(\d+)\x00/g, (_match, idx) => tableBlocks[Number(idx)]);

  return result;
}

/**
 * Make text safe for Telegram HTML parse mode during streaming.
 * Closes unclosed HTML tags from partial markdown conversion.
 */
export function makeHtmlSafe(text: string): string {
  return markdownToHtml(text);
}

/** @deprecated Use makeHtmlSafe instead */
export function makeMarkdownSafe(text: string): string {
  return makeHtmlSafe(text);
}

// ── Stream Accumulator ──

export class StreamAccumulator {
  private chatId: number | string;
  private sender: TelegramSender;
  private editIntervalMs: number;
  private splitThreshold: number;

  // State
  private tgMessageId: number | null = null;
  private buffer = '';
  private thinkingBuffer = '';
  private imageBase64Buffer = '';
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | 'image' | null = null;
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingIndicatorShown = false;
  private toolIndicators: string[] = [];
  private messageIds: number[] = []; // all message IDs sent during this turn
  private finished = false;
  private sendQueue: Promise<void> = Promise.resolve();
  private turnUsage: TurnUsage | null = null;

  constructor(options: StreamAccumulatorOptions) {
    this.chatId = options.chatId;
    this.sender = options.sender;
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.splitThreshold = options.splitThreshold ?? 4000;
  }

  get allMessageIds(): number[] { return [...this.messageIds]; }

  /** Set usage stats for the current turn (called from bridge on result event) */
  setTurnUsage(usage: TurnUsage): void {
    this.turnUsage = usage;
  }

  // ── Process stream events ──

  async handleEvent(event: StreamInnerEvent): Promise<void> {
    switch (event.type) {
      case 'message_start':
        // New assistant turn — reset buffer but keep tgMessageId to edit same message
        this.softReset();
        break;

      case 'content_block_start':
        await this.onContentBlockStart(event as StreamContentBlockStart);
        break;

      case 'content_block_delta':
        await this.onContentBlockDelta(event);
        break;

      case 'content_block_stop':
        if (this.currentBlockType === 'thinking' && this.thinkingBuffer) {
          // Thinking block complete — store for later rendering with text
          // Will be prepended as expandable blockquote when text starts or on finalize
        } else if (this.currentBlockType === 'image' && this.imageBase64Buffer) {
          await this.sendImage();
        }
        this.currentBlockType = null;
        break;

      case 'message_stop':
        await this.finalize();
        break;
    }
  }

  private async onContentBlockStart(event: StreamContentBlockStart): Promise<void> {
    const blockType = event.content_block.type;

    if (blockType === 'thinking') {
      this.currentBlockType = 'thinking';
      if (!this.thinkingIndicatorShown && !this.buffer) {
        await this.sendOrEdit('<i>💭 Thinking...</i>', true);
        this.thinkingIndicatorShown = true;
      }
    } else if (blockType === 'text') {
      this.currentBlockType = 'text';
      // Clear tool indicators when real text starts
      this.toolIndicators = [];
    } else if (blockType === 'tool_use') {
      this.currentBlockType = 'tool_use';
      const name = (event.content_block as { type: 'tool_use'; name: string }).name;
      this.toolIndicators.push(name);
      await this.showToolIndicator(name);
    } else if (blockType === 'image') {
      this.currentBlockType = 'image';
      this.imageBase64Buffer = '';
    }
  }

  private async onContentBlockDelta(event: StreamInnerEvent): Promise<void> {
    if (this.currentBlockType === 'text' && 'delta' in event) {
      const delta = (event as StreamTextDelta).delta;
      if (delta?.type === 'text_delta') {
        this.buffer += delta.text;
        await this.throttledEdit();
      }
    } else if (this.currentBlockType === 'thinking' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.thinkingBuffer += delta.thinking;
      }
    } else if (this.currentBlockType === 'image' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'image_delta' && delta.data) {
        this.imageBase64Buffer += delta.data;
      }
    }
    // Ignore input_json_delta content
  }

  // ── TG message management ──

  /** Send or edit a message. If rawHtml is true, text is already HTML-safe. */
  private async sendOrEdit(text: string, rawHtml = false): Promise<void> {
    this.sendQueue = this.sendQueue.then(() => this._doSendOrEdit(text, rawHtml));
    return this.sendQueue;
  }

  private async _doSendOrEdit(text: string, rawHtml = false): Promise<void> {
    const safeText = (rawHtml ? text : makeHtmlSafe(text)) || '...';
    try {
      if (!this.tgMessageId) {
        this.tgMessageId = await this.sender.sendMessage(this.chatId, safeText, 'HTML');
        this.messageIds.push(this.tgMessageId);
      } else {
        await this.sender.editMessage(this.chatId, this.tgMessageId, safeText, 'HTML');
      }
      this.lastEditTime = Date.now();
    } catch (err: unknown) {
      // Handle TG rate limit (429)
      if (err && typeof err === 'object' && 'error_code' in err && (err as { error_code: number }).error_code === 429) {
        const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5;
        this.editIntervalMs = Math.min(this.editIntervalMs * 2, 5000);
        await sleep(retryAfter * 1000);
        return this._doSendOrEdit(text);
      }
      // Ignore "message is not modified" errors
      if (err instanceof Error && err.message.includes('message is not modified')) return;
      throw err;
    }
  }

  private async sendImage(): Promise<void> {
    if (!this.sender.sendPhoto || !this.imageBase64Buffer) return;

    try {
      const imageBuffer = Buffer.from(this.imageBase64Buffer, 'base64');
      const msgId = await this.sender.sendPhoto(this.chatId, imageBuffer);
      this.messageIds.push(msgId);
    } catch (err) {
      // Fall back to text indicator on failure
      this.buffer += '\n[Image could not be sent]';
    }
    this.imageBase64Buffer = '';
  }

  private async showToolIndicator(toolName: string): Promise<void> {
    const bufferHtml = this.buffer ? makeHtmlSafe(this.buffer) : '';
    const indicator = bufferHtml
      ? `${bufferHtml}\n\n<i>Using ${escapeHtml(toolName)}...</i>`
      : `<i>Using ${escapeHtml(toolName)}...</i>`;
    await this.sendOrEdit(indicator, true);
  }

  private async throttledEdit(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastEditTime;

    if (elapsed >= this.editIntervalMs) {
      // Enough time passed — edit now
      await this.doEdit();
    } else if (!this.editTimer) {
      // Schedule an edit
      const delay = this.editIntervalMs - elapsed;
      this.editTimer = setTimeout(async () => {
        this.editTimer = null;
        if (!this.finished) {
          await this.doEdit();
        }
      }, delay);
    }
  }

  /** Build the full message text including thinking blockquote prefix and usage footer.
   *  Returns { text, hasHtmlSuffix } — caller must pass rawHtml=true when hasHtmlSuffix is set
   *  because the footer contains pre-formatted HTML (<i> tags).
   */
  private buildFullText(includeSuffix = false): { text: string; hasHtmlSuffix: boolean } {
    let text = '';
    if (this.thinkingBuffer) {
      const thinkingPreview = this.thinkingBuffer.length > 1024
        ? this.thinkingBuffer.slice(0, 1024) + '…'
        : this.thinkingBuffer;
      text += `<blockquote expandable>💭 Thinking\n${escapeHtml(thinkingPreview)}</blockquote>\n`;
    }
    // Convert markdown buffer to HTML-safe text
    text += makeHtmlSafe(this.buffer);
    if (includeSuffix && this.turnUsage) {
      text += '\n' + formatUsageFooter(this.turnUsage);
    }
    return { text, hasHtmlSuffix: includeSuffix && !!this.turnUsage };
  }

  private async doEdit(): Promise<void> {
    if (!this.buffer) return;

    const { text, hasHtmlSuffix } = this.buildFullText();

    // Check if we need to split
    if (text.length > this.splitThreshold) {
      await this.splitMessage();
      return;
    }

    await this.sendOrEdit(text, true); // buildFullText already does makeHtmlSafe
  }

  private async splitMessage(): Promise<void> {
    // Find a good split point near the threshold
    const splitAt = findSplitPoint(this.buffer, this.splitThreshold);
    const firstPart = this.buffer.slice(0, splitAt);
    const remainder = this.buffer.slice(splitAt);

    // Finalize current message with first part
    await this.sendOrEdit(makeHtmlSafe(firstPart), true);

    // Start a new message for remainder
    this.tgMessageId = null;
    this.buffer = remainder;

    if (this.buffer) {
      await this.sendOrEdit(makeHtmlSafe(this.buffer), true);
    }
  }

  async finalize(): Promise<void> {
    this.finished = true;

    // Clear any pending edit timer
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    if (this.buffer) {
      // Final edit with complete text including thinking blockquote and usage footer
      const { text } = this.buildFullText(true);
      await this.sendOrEdit(text, true); // buildFullText already does makeHtmlSafe
    } else if (this.thinkingBuffer && this.thinkingIndicatorShown) {
      // Only thinking happened, no text — show thinking as expandable blockquote
      const thinkingPreview = this.thinkingBuffer.length > 1024
        ? this.thinkingBuffer.slice(0, 1024) + '…'
        : this.thinkingBuffer;
      await this.sendOrEdit(
        `<blockquote expandable>💭 Thinking\n${escapeHtml(thinkingPreview)}</blockquote>`,
        true,
      );
    }
  }

  /** Soft reset: clear buffer/state but keep tgMessageId so next turn edits the same message */
  softReset(): void {
    this.buffer = '';
    this.thinkingBuffer = '';
    this.imageBase64Buffer = '';
    this.currentBlockType = null;
    this.lastEditTime = 0;
    this.thinkingIndicatorShown = false;
    this.toolIndicators = [];
    this.finished = false;
    this.turnUsage = null;
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  /** Full reset: also clears tgMessageId (next send creates a new message) */
  reset(): void {
    this.softReset();
    this.tgMessageId = null;
    this.messageIds = [];
    this.sendQueue = Promise.resolve();
  }
}

// ── Helpers ──

function findSplitPoint(text: string, threshold: number): number {
  // Try to split at paragraph break
  const paragraphBreak = text.lastIndexOf('\n\n', threshold);
  if (paragraphBreak > threshold * 0.5) return paragraphBreak;

  // Try to split at line break
  const lineBreak = text.lastIndexOf('\n', threshold);
  if (lineBreak > threshold * 0.5) return lineBreak;

  // Try to split at sentence end
  const sentenceEnd = text.lastIndexOf('. ', threshold);
  if (sentenceEnd > threshold * 0.5) return sentenceEnd + 2;

  // Fall back to threshold
  return threshold;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Format token count as human-readable: 1234 → "1.2k", 500 → "500" */
function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** Format usage stats as an HTML italic footer line */
export function formatUsageFooter(usage: TurnUsage): string {
  const parts = [
    `↩️ ${formatTokens(usage.inputTokens)} in`,
    `${formatTokens(usage.outputTokens)} out`,
  ];
  if (usage.costUsd != null) {
    parts.push(`$${usage.costUsd.toFixed(4)}`);
  }
  return `<i>${parts.join(' · ')}</i>`;
}

// ── Sub-agent detection patterns ──

const SUB_AGENT_TOOL_PATTERNS = [/agent/i, /dispatch/i, /^task$/i];

export function isSubAgentTool(toolName: string): boolean {
  return SUB_AGENT_TOOL_PATTERNS.some(p => p.test(toolName));
}

/** Extract a human-readable summary from partial/complete JSON tool input.
 *  Looks for prompt, task, command, description fields — returns the first found, truncated.
 */
export function extractSubAgentSummary(jsonInput: string, maxLen = 150): string {
  try {
    const parsed = JSON.parse(jsonInput);
    const value = parsed.prompt || parsed.task || parsed.command || parsed.description || parsed.message || '';
    if (typeof value === 'string' && value.length > 0) {
      return value.length > maxLen ? value.slice(0, maxLen) + '…' : value;
    }
  } catch {
    // Partial JSON — try regex extraction for common patterns
    for (const key of ['prompt', 'task', 'command', 'description', 'message']) {
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 'i');
      const m = jsonInput.match(re);
      if (m?.[1]) {
        const val = m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"');
        return val.length > maxLen ? val.slice(0, maxLen) + '…' : val;
      }
    }
  }
  return '';
}

/**
 * Extract a human-readable label for a sub-agent from its JSON tool input.
 * Uses CC's Task tool structured fields: name, description, subagent_type, team_name.
 * No regex guessing — purely structural JSON field extraction.
 */
export function extractAgentLabel(jsonInput: string): string {
  // Priority order of CC Task tool fields
  const labelFields = ['name', 'description', 'subagent_type', 'team_name'];
  const summaryField = 'prompt'; // last resort — first line of prompt

  try {
    const parsed = JSON.parse(jsonInput);
    for (const key of labelFields) {
      const val = parsed[key];
      if (typeof val === 'string' && val.trim()) {
        return val.trim().slice(0, 80);
      }
    }
    if (typeof parsed[summaryField] === 'string' && parsed[summaryField].trim()) {
      const firstLine = parsed[summaryField].trim().split('\n')[0];
      return firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
    }
    return '';
  } catch {
    // JSON incomplete during streaming — extract first complete field value
    return extractFieldFromPartialJson(jsonInput, labelFields) ?? '';
  }
}

/** Extract the first complete string value for any of the given keys from partial JSON. */
function extractFieldFromPartialJson(input: string, keys: string[]): string | null {
  for (const key of keys) {
    const idx = input.indexOf(`"${key}"`);
    if (idx === -1) continue;
    const afterKey = input.slice(idx + key.length + 2);
    const colonIdx = afterKey.indexOf(':');
    if (colonIdx === -1) continue;
    const afterColon = afterKey.slice(colonIdx + 1).trimStart();
    if (!afterColon.startsWith('"')) continue;
    // Walk the string handling escapes
    let i = 1, value = '';
    while (i < afterColon.length) {
      if (afterColon[i] === '\\' && i + 1 < afterColon.length) {
        value += afterColon[i + 1] === 'n' ? ' ' : afterColon[i + 1];
        i += 2;
      } else if (afterColon[i] === '"') {
        if (value.trim()) return value.trim().slice(0, 80);
        break;
      } else {
        value += afterColon[i];
        i++;
      }
    }
  }
  return null;
}

// ── Sub-Agent Tracker ──

export interface SubAgentInfo {
  toolUseId: string;
  toolName: string;
  blockIndex: number;
  tgMessageId: number | null;
  status: 'running' | 'dispatched' | 'completed' | 'failed';
  label: string;
  agentName: string;  // CC's agent name (used as 'from' in mailbox)
  inputPreview: string;
  dispatchedAt: number | null;         // timestamp when dispatched (for elapsed timer)
  elapsedTimer: ReturnType<typeof setInterval> | null;  // periodic edit timer
}

export interface SubAgentSender {
  sendMessage(chatId: number | string, text: string, parseMode?: string): Promise<number>;
  editMessage(chatId: number | string, messageId: number, text: string, parseMode?: string): Promise<void>;
}

export interface SubAgentTrackerOptions {
  chatId: number | string;
  sender: SubAgentSender;
}

/** A single mailbox message from a CC background sub-agent. */
export interface MailboxMessage {
  from: string;
  text: string;
  summary: string;
  timestamp: string;
  color?: string;
  read: boolean;
}

/** Callback invoked when all tracked sub-agents have reported via mailbox. */
export type AllAgentsReportedCallback = () => void;

export class SubAgentTracker {
  private chatId: number | string;
  private sender: SubAgentSender;
  private agents = new Map<string, SubAgentInfo>();        // toolUseId → info
  private blockToAgent = new Map<number, string>();         // blockIndex → toolUseId
  private sendQueue: Promise<void> = Promise.resolve();
  private teamName: string | null = null;
  private mailboxPath: string | null = null;
  private mailboxWatching = false;
  private lastMailboxCount = 0;
  private onAllReported: AllAgentsReportedCallback | null = null;
  hasPendingFollowUp = false;

  constructor(options: SubAgentTrackerOptions) {
    this.chatId = options.chatId;
    this.sender = options.sender;
  }

  get activeAgents(): SubAgentInfo[] {
    return [...this.agents.values()];
  }

  /** Returns true if any sub-agents were tracked in this turn (including completed ones) */
  get hadSubAgents(): boolean {
    return this.agents.size > 0;
  }

  /** Returns true if any sub-agents are in dispatched state (spawned but no result yet) */
  get hasDispatchedAgents(): boolean {
    return [...this.agents.values()].some(a => a.status === 'dispatched');
  }

  /** Mark all dispatched agents as completed — used when CC reports results
   *  in its main text response rather than via tool_result events.
   */
  markDispatchedAsReportedInMain(): void {
    for (const [, info] of this.agents) {
      if (info.status !== 'dispatched' || !info.tgMessageId) continue;
      info.status = 'completed';
      // Clear elapsed timer
      if (info.elapsedTimer) {
        clearInterval(info.elapsedTimer);
        info.elapsedTimer = null;
      }
      const label = info.label || info.toolName;
      const text = `✅ ${escapeHtml(label)} — see main message`;
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          await this.sender.editMessage(this.chatId, info.tgMessageId!, text, 'HTML');
        } catch { /* ignore */ }
      });
    }
  }

  async handleEvent(event: StreamInnerEvent): Promise<void> {
    switch (event.type) {
      case 'content_block_start':
        await this.onBlockStart(event as StreamContentBlockStart);
        break;

      case 'content_block_delta': {
        const delta = event as StreamInputJsonDelta;
        if (delta.delta?.type === 'input_json_delta') {
          await this.onInputDelta(delta);
        }
        break;
      }

      case 'content_block_stop':
        await this.onBlockStop(event as StreamContentBlockStop);
        break;

      // NOTE: message_start reset is handled by the bridge (not here)
      // so it can check hadSubAgents before clearing state
    }
  }

  /** Handle a tool_result event — marks the sub-agent as completed with collapsible result */
  /** Mark an agent as completed externally (e.g. from bridge follow-up) */
  markCompleted(toolUseId: string, _reason: string): void {
    const info = this.agents.get(toolUseId);
    if (!info || info.status === 'completed') return;
    info.status = 'completed';
    if (info.elapsedTimer) { clearInterval(info.elapsedTimer); info.elapsedTimer = null; }
    // Check if all agents are done
    const allDone = ![...this.agents.values()].some(a => a.status === 'dispatched');
    if (allDone && this.onAllReported) {
      this.onAllReported();
      this.stopMailboxWatch();
    }
  }

  async handleToolResult(toolUseId: string, result: string): Promise<void> {
    const info = this.agents.get(toolUseId);
    if (!info || !info.tgMessageId) return;

    // Detect background agent spawn confirmations — keep as dispatched, don't mark completed
    // Spawn confirmations contain "agent_id:" and "Spawned" patterns
    const isSpawnConfirmation = /agent_id:\s*\S+@\S+/.test(result) || /[Ss]pawned\s+successfully/i.test(result);
    
    if (isSpawnConfirmation) {
      // Extract agent name from spawn confirmation for mailbox matching
      const nameMatch = result.match(/name:\s*(\S+)/);
      if (nameMatch && !info.agentName) info.agentName = nameMatch[1];
      const agentIdMatch = result.match(/agent_id:\s*(\S+)@/);
      if (agentIdMatch && !info.agentName) info.agentName = agentIdMatch[1];

      // Mark as dispatched — this enables mailbox watching and prevents idle timeout
      info.status = 'dispatched';
      info.dispatchedAt = Date.now();

      const label = info.label || info.toolName;
      const text = `🤖 ${escapeHtml(label)} — Spawned, waiting for results…`;
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          await this.sender.editMessage(this.chatId, info.tgMessageId!, text, 'HTML');
        } catch { /* ignore */ }
      });
      await this.sendQueue;
      return;
    }

    // Clear elapsed timer
    this.clearElapsedTimer(info);

    info.status = 'completed';

    const label = info.label || info.toolName;
    // Truncate result for blockquote (TG message limit ~4096 chars)
    const maxResultLen = 3500;
    const resultText = result.length > maxResultLen ? result.slice(0, maxResultLen) + '…' : result;

    // Use expandable blockquote — collapsed shows "✅ label" + first line, tap to expand
    const text = `<blockquote expandable>✅ ${escapeHtml(label)}\n${escapeHtml(resultText)}</blockquote>`;

    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(
          this.chatId,
          info.tgMessageId!,
          text,
          'HTML',
        );
      } catch {
        // Ignore edit failures
      }
    });
    await this.sendQueue;
  }

  private async onBlockStart(event: StreamContentBlockStart): Promise<void> {
    if (event.content_block.type !== 'tool_use') return;

    const block = event.content_block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
    if (!isSubAgentTool(block.name)) return;

    const info: SubAgentInfo = {
      toolUseId: block.id,
      toolName: block.name,
      blockIndex: event.index,
      tgMessageId: null,
      status: 'running',
      label: '',
      agentName: '',
      inputPreview: '',
      dispatchedAt: null,
      elapsedTimer: null,
    };

    this.agents.set(block.id, info);
    this.blockToAgent.set(event.index, block.id);

    // Send standalone message (no reply_to — cleaner in private chat)
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        const msgId = await this.sender.sendMessage(
          this.chatId,
          '🤖 Starting sub-agent…',
          'HTML',
        );
        info.tgMessageId = msgId;
      } catch (err) {
        // Silently ignore — main stream continues regardless
      }
    });
    await this.sendQueue;
  }

  private async onInputDelta(event: StreamInputJsonDelta): Promise<void> {
    const toolUseId = this.blockToAgent.get(event.index);
    if (!toolUseId) return;

    const info = this.agents.get(toolUseId);
    if (!info || !info.tgMessageId) return;

    info.inputPreview += event.delta.partial_json;

    // Extract agent name from input JSON (used for mailbox matching)
    if (!info.agentName) {
      try {
        const parsed = JSON.parse(info.inputPreview);
        if (typeof parsed.name === 'string' && parsed.name.trim()) {
          info.agentName = parsed.name.trim();
        }
      } catch {
        // Partial JSON — try extracting name field
        const nameMatch = info.inputPreview.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) info.agentName = nameMatch[1];
      }
    }

    // Try to extract an agent label
    if (!info.label) {
      const label = extractAgentLabel(info.inputPreview);
      if (label) {
        info.label = label;
        // Once we have a label, update the message to show it
        const displayLabel = info.label;
        this.sendQueue = this.sendQueue.then(async () => {
          try {
            await this.sender.editMessage(
              this.chatId,
              info.tgMessageId!,
              `🤖 ${escapeHtml(displayLabel)} — Working…`,
              'HTML',
            );
          } catch {
            // Ignore edit failures
          }
        });
        await this.sendQueue;
      }
    }
  }

  private async onBlockStop(event: StreamContentBlockStop): Promise<void> {
    const toolUseId = this.blockToAgent.get(event.index);
    if (!toolUseId) return;

    const info = this.agents.get(toolUseId);
    if (!info || !info.tgMessageId) return;

    // content_block_stop = input done, NOT sub-agent done. Mark as dispatched.
    info.status = 'dispatched';
    info.dispatchedAt = Date.now();

    // Final chance to extract label from complete input
    if (!info.label) {
      const label = extractAgentLabel(info.inputPreview);
      if (label) info.label = label;
    }

    const displayLabel = info.label || info.toolName;
    const text = `🤖 ${escapeHtml(displayLabel)} — Working…`;

    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(
          this.chatId,
          info.tgMessageId!,
          text,
          'HTML',
        );
      } catch {
        // Ignore edit failures
      }
    });
    await this.sendQueue;

    // Start elapsed timer — update every 15s to show progress
    this.startElapsedTimer(info);
  }

  /** Start a periodic timer that edits the message with elapsed time */
  private startElapsedTimer(info: SubAgentInfo): void {
    if (info.elapsedTimer) return; // already running

    const displayLabel = info.label || info.toolName;

    info.elapsedTimer = setInterval(() => {
      if (info.status !== 'dispatched' || !info.tgMessageId || !info.dispatchedAt) {
        this.clearElapsedTimer(info);
        return;
      }

      const elapsedSec = Math.round((Date.now() - info.dispatchedAt) / 1000);
      const text = `🤖 ${escapeHtml(displayLabel)} — Working… (${elapsedSec}s)`;

      this.sendQueue = this.sendQueue.then(async () => {
        // Re-check status inside the queue — mailbox completion may have run first
        if (info.status !== 'dispatched') return;
        try {
          await this.sender.editMessage(
            this.chatId,
            info.tgMessageId!,
            text,
            'HTML',
          );
        } catch {
          // Ignore edit failures (rate limits, not modified, etc.)
        }
      });
    }, 15_000);
  }

  /** Clear the elapsed timer for a sub-agent */
  private clearElapsedTimer(info: SubAgentInfo): void {
    if (info.elapsedTimer) {
      clearInterval(info.elapsedTimer);
      info.elapsedTimer = null;
    }
  }

  /** Set callback invoked when ALL dispatched sub-agents have mailbox results. */
  setOnAllReported(cb: AllAgentsReportedCallback | null): void {
    this.onAllReported = cb;
  }

  /** Set the CC team name (extracted from spawn confirmation tool_result). */
  setTeamName(name: string): void {
    this.teamName = name;
    this.mailboxPath = join(
      homedir(),
      '.claude', 'teams', name, 'inboxes', 'team-lead.json',
    );
  }

  get currentTeamName(): string | null { return this.teamName; }
  get isMailboxWatching(): boolean { return this.mailboxWatching; }

  /** Start watching the mailbox file for sub-agent results. */
  startMailboxWatch(): void {
    if (this.mailboxWatching) {
      
      return;
    }
    if (!this.mailboxPath) {
      
      return;
    }
    
    this.mailboxWatching = true;

    // Ensure directory exists so watchFile doesn't error
    const dir = dirname(this.mailboxPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Start from 0 — process all messages including pre-existing ones
    // Background agents may finish before the watcher starts
    this.lastMailboxCount = 0;

    // Process immediately in case messages arrived before watching
    this.processMailbox();

    watchFile(this.mailboxPath, { interval: 2000 }, () => {
      this.processMailbox();
    });
  }

  /** Stop watching the mailbox file. */
  stopMailboxWatch(): void {
    if (!this.mailboxWatching || !this.mailboxPath) return;
    try {
      unwatchFile(this.mailboxPath);
    } catch { /* ignore */ }
    this.mailboxWatching = false;
  }

  /** Read and parse the mailbox file. Returns [] on any error. */
  private readMailboxMessages(): MailboxMessage[] {
    if (!this.mailboxPath || !existsSync(this.mailboxPath)) return [];
    try {
      const raw = readFileSync(this.mailboxPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  /** Process new mailbox messages and update sub-agent TG messages. */
  private processMailbox(): void {
    const messages = this.readMailboxMessages();
    if (messages.length <= this.lastMailboxCount) return;

    const newMessages = messages.slice(this.lastMailboxCount);
    this.lastMailboxCount = messages.length;

    for (const msg of newMessages) {
      // Don't filter by msg.read — CC may read its mailbox before our 2s poll fires
      // We track by message count (lastMailboxCount) to avoid duplicates

      // Skip idle notifications (JSON objects, not real results)
      if (msg.text.startsWith('{')) continue;

      // Match msg.from to a tracked sub-agent by label
      const matched = this.findAgentByFrom(msg.from);
      if (!matched) continue;

      // Clear elapsed timer
      this.clearElapsedTimer(matched);
      matched.status = 'completed';

      if (!matched.tgMessageId) continue;

      const label = matched.label || matched.toolName;
      const summary = msg.summary || 'Done';
      // Truncate text for blockquote (TG limit)
      const maxTextLen = 1024;
      const bodyText = msg.text.length > maxTextLen
        ? msg.text.slice(0, maxTextLen) + '…'
        : msg.text;

      const colorEmoji = msg.color === 'green' ? '✅'
        : msg.color === 'red' ? '❌'
        : msg.color === 'yellow' ? '⚠️'
        : '✅';

      const text = `<blockquote expandable>${colorEmoji} ${escapeHtml(label)} — ${escapeHtml(summary)}\n${escapeHtml(bodyText)}</blockquote>`;

      const msgId = matched.tgMessageId;
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          await this.sender.editMessage(this.chatId, msgId, text, 'HTML');
        } catch { /* ignore */ }
      });
    }

    // Check if ALL dispatched agents are now completed
    if (this.onAllReported && !this.hasDispatchedAgents && this.agents.size > 0) {
      // All done — invoke callback
      const cb = this.onAllReported;
      // Defer slightly to let edits flush
      setTimeout(() => cb(), 500);
    }
  }

  /** Find a tracked sub-agent whose label matches the mailbox message's `from` field. */
  private findAgentByFrom(from: string): SubAgentInfo | null {
    const fromLower = from.toLowerCase();
    for (const info of this.agents.values()) {
      if (info.status !== 'dispatched') continue;
      // Primary match: agentName (CC's internal agent name, used as mailbox 'from')
      if (info.agentName && info.agentName.toLowerCase() === fromLower) {
        return info;
      }
      // Fallback: fuzzy label match
      const label = (info.label || info.toolName).toLowerCase();
      if (label === fromLower || label.includes(fromLower) || fromLower.includes(label)) {
        return info;
      }
    }
    return null;
  }

  reset(): void {
    // Stop mailbox watching
    this.stopMailboxWatch();
    // Clear all elapsed timers before resetting
    for (const info of this.agents.values()) {
      this.clearElapsedTimer(info);
    }
    this.agents.clear();
    this.blockToAgent.clear();
    this.sendQueue = Promise.resolve();
    this.teamName = null;
    this.mailboxPath = null;
    this.lastMailboxCount = 0;
    this.onAllReported = null;
  }
}

// ── Utility: split a completed text into TG-sized chunks ──

export function splitText(text: string, maxLength: number = 4000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const splitAt = findSplitPoint(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
