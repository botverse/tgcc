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
export function markdownToHtml(text: string): string {
  // First, extract code blocks to protect them from other conversions
  const codeBlocks: string[] = [];
  let result = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang, code) => {
    const idx = codeBlocks.length;
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push(`<pre><code${langAttr}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00CODEBLOCK${idx}\x00`;
  });

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

  // Restore code blocks and inline code
  result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, idx) => codeBlocks[Number(idx)]);
  result = result.replace(/\x00INLINE(\d+)\x00/g, (_match, idx) => inlineCodes[Number(idx)]);

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
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | null = null;
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingIndicatorShown = false;
  private toolIndicators: string[] = [];
  private messageIds: number[] = []; // all message IDs sent during this turn
  private finished = false;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options: StreamAccumulatorOptions) {
    this.chatId = options.chatId;
    this.sender = options.sender;
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.splitThreshold = options.splitThreshold ?? 4000;
  }

  get allMessageIds(): number[] { return [...this.messageIds]; }

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
    }
  }

  private async onContentBlockDelta(event: StreamInnerEvent): Promise<void> {
    if (this.currentBlockType === 'text' && 'delta' in event) {
      const delta = (event as StreamTextDelta).delta;
      if (delta?.type === 'text_delta') {
        this.buffer += delta.text;
        await this.throttledEdit();
      }
    }
    // Ignore thinking_delta and input_json_delta content
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

  private async doEdit(): Promise<void> {
    if (!this.buffer) return;

    // Check if we need to split
    if (this.buffer.length > this.splitThreshold) {
      await this.splitMessage();
      return;
    }

    await this.sendOrEdit(this.buffer);
  }

  private async splitMessage(): Promise<void> {
    // Find a good split point near the threshold
    const splitAt = findSplitPoint(this.buffer, this.splitThreshold);
    const firstPart = this.buffer.slice(0, splitAt);
    const remainder = this.buffer.slice(splitAt);

    // Finalize current message with first part
    await this.sendOrEdit(firstPart);

    // Start a new message for remainder
    this.tgMessageId = null;
    this.buffer = remainder;

    if (this.buffer) {
      await this.sendOrEdit(this.buffer);
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
      // Final edit with complete text — no markdown safety needed (complete content)
      await this.sendOrEdit(this.buffer);
    } else if (this.thinkingIndicatorShown && !this.buffer) {
      // Only thinking indicator was shown, no actual text — remove it
      // This can happen on tool-only responses
    }
  }

  /** Soft reset: clear buffer/state but keep tgMessageId so next turn edits the same message */
  softReset(): void {
    this.buffer = '';
    this.currentBlockType = null;
    this.lastEditTime = 0;
    this.thinkingIndicatorShown = false;
    this.toolIndicators = [];
    this.finished = false;
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

// ── Sub-agent detection patterns ──

const SUB_AGENT_TOOL_PATTERNS = [/agent/i, /dispatch/i, /^task$/i];

export function isSubAgentTool(toolName: string): boolean {
  return SUB_AGENT_TOOL_PATTERNS.some(p => p.test(toolName));
}

// ── Sub-Agent Tracker ──

export interface SubAgentInfo {
  toolUseId: string;
  toolName: string;
  blockIndex: number;
  tgMessageId: number | null;
  status: 'running' | 'completed' | 'failed';
  inputPreview: string;
}

export interface SubAgentSender {
  replyToMessage(chatId: number | string, text: string, replyToMessageId: number, parseMode?: string): Promise<number>;
  editMessage(chatId: number | string, messageId: number, text: string, parseMode?: string): Promise<void>;
}

export interface SubAgentTrackerOptions {
  chatId: number | string;
  sender: SubAgentSender;
  /** Returns the main streaming message ID to reply to */
  getMainMessageId: () => number | null;
}

export class SubAgentTracker {
  private chatId: number | string;
  private sender: SubAgentSender;
  private getMainMessageId: () => number | null;
  private agents = new Map<string, SubAgentInfo>();        // toolUseId → info
  private blockToAgent = new Map<number, string>();         // blockIndex → toolUseId
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options: SubAgentTrackerOptions) {
    this.chatId = options.chatId;
    this.sender = options.sender;
    this.getMainMessageId = options.getMainMessageId;
  }

  get activeAgents(): SubAgentInfo[] {
    return [...this.agents.values()];
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

      case 'message_start':
        // New turn — reset tracker
        this.reset();
        break;
    }
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
      inputPreview: '',
    };

    this.agents.set(block.id, info);
    this.blockToAgent.set(event.index, block.id);

    // Send reply message
    const mainMsgId = this.getMainMessageId();
    if (mainMsgId) {
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          const msgId = await this.sender.replyToMessage(
            this.chatId,
            `🔄 Sub-agent spawned: <code>${escapeHtml(block.name)}</code>`,
            mainMsgId,
            'HTML',
          );
          info.tgMessageId = msgId;
        } catch (err) {
          // Silently ignore — main stream continues regardless
        }
      });
      await this.sendQueue;
    }
  }

  private async onInputDelta(event: StreamInputJsonDelta): Promise<void> {
    const toolUseId = this.blockToAgent.get(event.index);
    if (!toolUseId) return;

    const info = this.agents.get(toolUseId);
    if (!info || !info.tgMessageId) return;

    info.inputPreview += event.delta.partial_json;

    // Throttle: only update when we have a reasonable chunk (every 200 chars)
    if (info.inputPreview.length % 200 > 50) return;

    const preview = info.inputPreview.length > 300
      ? info.inputPreview.slice(0, 300) + '…'
      : info.inputPreview;

    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(
          this.chatId,
          info.tgMessageId!,
          `🔄 Sub-agent: <code>${escapeHtml(info.toolName)}</code>\n\n<pre>${escapeHtml(preview)}</pre>`,
          'HTML',
        );
      } catch {
        // Ignore edit failures (rate limits, not modified, etc.)
      }
    });
    await this.sendQueue;
  }

  private async onBlockStop(event: StreamContentBlockStop): Promise<void> {
    const toolUseId = this.blockToAgent.get(event.index);
    if (!toolUseId) return;

    const info = this.agents.get(toolUseId);
    if (!info || !info.tgMessageId) return;

    info.status = 'completed';

    // Extract a summary from the input preview (first ~100 chars)
    let summary = '';
    try {
      const parsed = JSON.parse(info.inputPreview);
      // Common patterns: { prompt: "..." }, { task: "..." }, { command: "..." }
      summary = parsed.prompt || parsed.task || parsed.command || parsed.description || '';
      if (typeof summary === 'string' && summary.length > 100) {
        summary = summary.slice(0, 100) + '…';
      }
    } catch {
      summary = info.inputPreview.slice(0, 100);
      if (info.inputPreview.length > 100) summary += '…';
    }

    const text = summary
      ? `✅ Sub-agent completed: <code>${escapeHtml(info.toolName)}</code>\n<i>${escapeHtml(summary)}</i>`
      : `✅ Sub-agent completed: <code>${escapeHtml(info.toolName)}</code>`;

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

  reset(): void {
    this.agents.clear();
    this.blockToAgent.clear();
    this.sendQueue = Promise.resolve();
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
