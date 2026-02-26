import { readFileSync, watchFile, unwatchFile, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type {
  StreamInnerEvent,
  StreamContentBlockStart,
  StreamContentBlockStop,
  StreamInputJsonDelta,
  StreamTextDelta,
  StreamMessageStart,
} from './cc-protocol.js';
import { markdownToTelegramHtml } from './telegram-html-remark.js';

// ── Types ──

export interface TelegramSender {
  sendMessage(chatId: number | string, text: string, parseMode?: string): Promise<number>;
  editMessage(chatId: number | string, messageId: number, text: string, parseMode?: string): Promise<void>;
  deleteMessage?(chatId: number | string, messageId: number): Promise<void>;
  sendPhoto?(chatId: number | string, imageBuffer: Buffer, caption?: string): Promise<number>;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number | null;
  model?: string;
  /** Tokens from the LAST API call's message_start — represents actual context window state.
   *  Unlike inputTokens/cacheReadTokens/cacheCreationTokens (cumulative across tool-use loops),
   *  these are per-call and bounded by the model's context window. Use for context % display. */
  ctxInputTokens?: number;
  ctxCacheReadTokens?: number;
  ctxCacheCreationTokens?: number;
}

export interface StreamAccumulatorOptions {
  chatId: number | string;
  sender: TelegramSender;
  editIntervalMs?: number;      // min ms between TG edits (default 1000)
  splitThreshold?: number;       // char count to trigger message split (default 4000)
  logger?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
  /** Callback for critical errors that should be surfaced to the user */
  onError?: (err: unknown, context: string) => void;
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
 * Convert markdown text to Telegram-safe HTML using the marked library.
 * Replaces the old hand-rolled implementation with a proper markdown parser.
 */
export function markdownToHtml(text: string): string {
  return markdownToTelegramHtml(text);
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
  private logger?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
  private onError?: (err: unknown, context: string) => void;

  // State
  private tgMessageId: number | null = null;
  private buffer = '';
  private thinkingBuffer = '';
  private imageBase64Buffer = '';
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | 'image' | null = null;
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingIndicatorShown = false;
  private messageIds: number[] = []; // all message IDs sent during this turn
  private finished = false;
  private sendQueue: Promise<void> = Promise.resolve();
  private turnUsage: TurnUsage | null = null;
  /** Usage from the most recent message_start event — represents a single API call's context (not cumulative). */
  private _lastMsgStartCtx: { input: number; cacheRead: number; cacheCreation: number } | null = null;

  // Per-tool-use independent indicator messages (persists across resets)
  private toolMessages: Map<string, { msgId: number; toolName: string; startTime: number }> = new Map();
  private toolInputBuffers: Map<string, string> = new Map(); // tool block ID → accumulated input JSON
  private currentToolBlockId: string | null = null;

  constructor(options: StreamAccumulatorOptions) {
    this.chatId = options.chatId;
    this.sender = options.sender;
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.splitThreshold = options.splitThreshold ?? 4000;
    this.logger = options.logger;
    this.onError = options.onError;
  }

  get allMessageIds(): number[] { return [...this.messageIds]; }

  /** Set usage stats for the current turn (called from bridge on result event) */
  setTurnUsage(usage: TurnUsage): void {
    // Merge in per-API-call ctx tokens if we captured them from message_start events.
    // These are bounded by the context window (unlike result event usage which accumulates across tool loops).
    if (this._lastMsgStartCtx) {
      this.turnUsage = {
        ...usage,
        ctxInputTokens: this._lastMsgStartCtx.input,
        ctxCacheReadTokens: this._lastMsgStartCtx.cacheRead,
        ctxCacheCreationTokens: this._lastMsgStartCtx.cacheCreation,
      };
    } else {
      this.turnUsage = usage;
    }
  }

  // ── Process stream events ──

  async handleEvent(event: StreamInnerEvent): Promise<void> {
    switch (event.type) {
      case 'message_start': {
        // Bridge handles reset decision - no automatic reset here
        // Capture per-API-call token counts for accurate context % (not cumulative like result event)
        const msUsage = (event as StreamMessageStart).message?.usage;
        if (msUsage) {
          this._lastMsgStartCtx = {
            input: (msUsage.input_tokens as number) ?? 0,
            cacheRead: (msUsage.cache_read_input_tokens as number) ?? 0,
            cacheCreation: (msUsage.cache_creation_input_tokens as number) ?? 0,
          };
        }
        break;
      }

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
        await this.sendOrEdit('<blockquote>💭 Thinking...</blockquote>', true);
        this.thinkingIndicatorShown = true;
      }
    } else if (blockType === 'text') {
      this.currentBlockType = 'text';
      // Text always gets its own message — don't touch tool indicator messages
      if (!this.tgMessageId) {
        // Will create a new message on next sendOrEdit
      }
    } else if (blockType === 'tool_use') {
      this.currentBlockType = 'tool_use';
      const block = event.content_block as { type: 'tool_use'; id: string; name: string };
      this.currentToolBlockId = block.id;
      // Send an independent indicator message for this tool_use block
      await this.sendToolIndicator(block.id, block.name);
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
        
        // Force split/truncation if buffer exceeds 50KB
        if (this.buffer.length > 50_000) {
          await this.forceSplitOrTruncate();
          return; // Skip throttledEdit - already handled in forceSplitOrTruncate
        }
        
        await this.throttledEdit();
      }
    } else if (this.currentBlockType === 'thinking' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'thinking_delta' && delta.thinking) {
        this.thinkingBuffer += delta.thinking;
      }
    } else if (this.currentBlockType === 'tool_use' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'input_json_delta' && delta.partial_json && this.currentToolBlockId) {
        const blockId = this.currentToolBlockId;
        const prev = this.toolInputBuffers.get(blockId) ?? '';
        this.toolInputBuffers.set(blockId, prev + delta.partial_json);
        // Update indicator with input preview once we have enough
        await this.updateToolIndicatorWithInput(blockId);
      }
    } else if (this.currentBlockType === 'image' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'image_delta' && delta.data) {
        this.imageBase64Buffer += delta.data;
      }
    }
  }

  // ── TG message management ──

  /** Send or edit a message. If rawHtml is true, text is already HTML-safe. */
  private async sendOrEdit(text: string, rawHtml = false): Promise<void> {
    this.sendQueue = this.sendQueue.then(() => this._doSendOrEdit(text, rawHtml)).catch(err => {
      this.logger?.error?.({ err }, 'sendOrEdit failed');
      this.onError?.(err, 'Failed to send/edit message');
    });
    return this.sendQueue;
  }

  private async _doSendOrEdit(text: string, rawHtml = false): Promise<void> {
    let safeText = (rawHtml ? text : makeHtmlSafe(text)) || '...';
    // Guard against HTML that has tags but no visible text content (e.g. "<b></b>")
    if (!safeText.replace(/<[^>]*>/g, '').trim()) safeText = '...';

    // Update timing BEFORE API call to prevent races
    this.lastEditTime = Date.now();

    try {
      if (!this.tgMessageId) {
        this.tgMessageId = await this.sender.sendMessage(this.chatId, safeText, 'HTML');
        this.messageIds.push(this.tgMessageId);
      } else {
        await this.sender.editMessage(this.chatId, this.tgMessageId, safeText, 'HTML');
      }
    } catch (err: unknown) {
      const errorCode = err && typeof err === 'object' && 'error_code' in err
        ? (err as { error_code: number }).error_code : 0;

      // Handle TG rate limit (429) — retry
      if (errorCode === 429) {
        const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5;
        this.editIntervalMs = Math.min(this.editIntervalMs * 2, 5000);
        await sleep(retryAfter * 1000);
        return this._doSendOrEdit(text);
      }
      // Ignore "message is not modified" errors (harmless)
      if (err instanceof Error && err.message.includes('message is not modified')) return;
      // 400 (bad request), 403 (forbidden), and all other errors — log and skip, never throw
      this.logger?.error?.({ err, errorCode }, 'Telegram API error in _doSendOrEdit — skipping');
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
      this.logger?.error?.({ err }, 'Failed to send image');
      this.buffer += '\n[Image could not be sent]';
    }
    this.imageBase64Buffer = '';
  }

  /** Send an independent tool indicator message (not through the accumulator's sendOrEdit). */
  private async sendToolIndicator(blockId: string, toolName: string): Promise<void> {
    const startTime = Date.now();
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        const html = `<blockquote expandable>⚡ ${escapeHtml(toolName)}…</blockquote>`;
        const msgId = await this.sender.sendMessage(this.chatId, html, 'HTML');
        this.toolMessages.set(blockId, { msgId, toolName, startTime });
      } catch (err) {
        // Tool indicator is non-critical — log and continue
        this.logger?.debug?.({ err, toolName }, 'Failed to send tool indicator');
      }
    }).catch(err => {
      this.logger?.error?.({ err }, 'sendToolIndicator queue error');
    });
    return this.sendQueue;
  }

  /** Update a tool indicator message with input preview once the JSON value is complete. */
  private toolIndicatorLastSummary = new Map<string, string>(); // blockId → last rendered summary
  private async updateToolIndicatorWithInput(blockId: string): Promise<void> {
    const entry = this.toolMessages.get(blockId);
    if (!entry) return;
    const inputJson = this.toolInputBuffers.get(blockId) ?? '';

    // Only extract from complete JSON (try parse succeeds) or complete regex match
    // (the value must have a closing quote to avoid truncated paths)
    const summary = extractToolInputSummary(entry.toolName, inputJson, 120, true);
    if (!summary) return; // not enough input yet or value still streaming

    // Skip if summary hasn't changed since last edit
    if (this.toolIndicatorLastSummary.get(blockId) === summary) return;
    this.toolIndicatorLastSummary.set(blockId, summary);

    const codeLine = `\n<code>${escapeHtml(summary)}</code>`;
    const html = `<blockquote expandable>⚡ ${escapeHtml(entry.toolName)}…${codeLine}</blockquote>`;

    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(this.chatId, entry.msgId, html, 'HTML');
      } catch (err) {
        // "message is not modified" or other edit failure — non-critical
        this.logger?.debug?.({ err }, 'Failed to update tool indicator with input');
      }
    }).catch(err => {
      this.logger?.error?.({ err }, 'updateToolIndicatorWithInput queue error');
    });
    return this.sendQueue;
  }

  /** Resolve a tool indicator with success/failure status. Edits to a compact summary with input detail. */
  async resolveToolMessage(blockId: string, isError: boolean, errorMessage?: string, resultContent?: string, toolUseResult?: Record<string, unknown>): Promise<void> {
    const entry = this.toolMessages.get(blockId);
    if (!entry) return;
    const { msgId, toolName, startTime } = entry;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const inputJson = this.toolInputBuffers.get(blockId) ?? '';
    const summary = extractToolInputSummary(toolName, inputJson);
    const resultStat = extractToolResultStat(toolName, resultContent, toolUseResult);
    const codeLine = summary ? `\n<code>${escapeHtml(summary)}</code>` : '';
    const statLine = resultStat ? `\n${escapeHtml(resultStat)}` : '';

    const icon = isError ? '❌' : '✅';
    const html = `<blockquote expandable>${icon} ${escapeHtml(toolName)} (${elapsed}s)${codeLine}${statLine}</blockquote>`;

    // Clean up input buffer
    this.toolInputBuffers.delete(blockId);
    this.toolIndicatorLastSummary.delete(blockId);

    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(this.chatId, msgId, html, 'HTML');
      } catch (err) {
        // Edit failure on resolve — non-critical
        this.logger?.debug?.({ err, toolName }, 'Failed to resolve tool indicator');
      }
    }).catch(err => {
      this.logger?.error?.({ err }, 'resolveToolMessage queue error');
    });
    return this.sendQueue;
  }

  /** Edit a specific tool indicator message by block ID. */
  async editToolMessage(blockId: string, html: string): Promise<void> {
    const entry = this.toolMessages.get(blockId);
    if (!entry) return;
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(this.chatId, entry.msgId, html, 'HTML');
      } catch (err) {
        // Edit failure — non-critical
        this.logger?.debug?.({ err }, 'Failed to edit tool message');
      }
    }).catch(err => {
      this.logger?.error?.({ err }, 'editToolMessage queue error');
    });
    return this.sendQueue;
  }

  /** Delete a specific tool indicator message by block ID. */
  async deleteToolMessage(blockId: string): Promise<void> {
    const entry = this.toolMessages.get(blockId);
    if (!entry) return;
    this.toolMessages.delete(blockId);
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        if (this.sender.deleteMessage) {
          await this.sender.deleteMessage(this.chatId, entry.msgId);
        }
      } catch (err) {
        // Delete failure — non-critical
        this.logger?.debug?.({ err }, 'Failed to delete tool message');
      }
    }).catch(err => {
      this.logger?.error?.({ err }, 'deleteToolMessage queue error');
    });
    return this.sendQueue;
  }

  /** Delete all tool indicator messages. */
  async deleteAllToolMessages(): Promise<void> {
    const ids = [...this.toolMessages.values()];
    this.toolMessages.clear();
    if (!this.sender.deleteMessage) return;
    this.sendQueue = this.sendQueue.then(async () => {
      for (const { msgId } of ids) {
        try {
          await this.sender.deleteMessage!(this.chatId, msgId);
        } catch (err) {
          // Delete failure — non-critical
          this.logger?.debug?.({ err }, 'Failed to delete tool message in batch');
        }
      }
    }).catch(err => {
      this.logger?.error?.({ err }, 'deleteAllToolMessages queue error');
    });
    return this.sendQueue;
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
      text += `<blockquote expandable>💭 Thinking\n${markdownToTelegramHtml(thinkingPreview)}</blockquote>\n`;
    }
    // Convert markdown buffer to HTML-safe text
    text += makeHtmlSafe(this.buffer);
    if (includeSuffix && this.turnUsage) {
      text += '\n' + formatUsageFooter(this.turnUsage, this.turnUsage.model);
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

  /** Emergency split/truncation when buffer exceeds 50KB absolute limit */
  private async forceSplitOrTruncate(): Promise<void> {
    const maxChars = 50_000;
    
    if (this.buffer.length > maxChars) {
      // Split at a reasonable point within the 50KB limit
      const splitAt = findSplitPoint(this.buffer, maxChars - 200); // Leave some margin
      const firstPart = this.buffer.slice(0, splitAt);
      const remainder = this.buffer.slice(splitAt);
      
      // Finalize current message with first part + truncation notice
      const truncationNotice = '\n\n<i>[Output truncated - buffer limit exceeded]</i>';
      await this.sendOrEdit(makeHtmlSafe(firstPart) + truncationNotice, true);
      
      // Start a new message for remainder (up to another 50KB)
      this.tgMessageId = null;
      this.buffer = remainder.length > maxChars 
        ? remainder.slice(0, maxChars - 100) + '...' 
        : remainder;
      
      if (this.buffer) {
        await this.sendOrEdit(makeHtmlSafe(this.buffer), true);
      }
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
        `<blockquote expandable>💭 Thinking\n${markdownToTelegramHtml(thinkingPreview)}</blockquote>`,
        true,
      );
    }
  }

  private clearEditTimer(): void {
    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }
  }

  /** Soft reset: clear buffer/state but keep tgMessageId so next turn edits the same message.
   *  toolMessages persists across resets — they are independent of the text accumulator. */
  softReset(): void {
    this.buffer = '';
    this.thinkingBuffer = '';
    this.imageBase64Buffer = '';
    this.currentBlockType = null;
    this.currentToolBlockId = null;
    this.lastEditTime = 0;
    this.thinkingIndicatorShown = false;
    this.finished = false;
    this.turnUsage = null;
    this._lastMsgStartCtx = null;
    this.clearEditTimer();
  }

  /** Full reset: also clears tgMessageId (next send creates a new message).
   *  Chains on the existing sendQueue so any pending finalize() edits complete first.
   *  toolMessages persists — they are independent fire-and-forget messages. */
  reset(): void {
    const prevQueue = this.sendQueue;
    this.softReset();
    this.tgMessageId = null;
    this.messageIds = [];
    this.sendQueue = prevQueue.catch(() => {});  // swallow errors from prev turn
  }
}

// ── Helpers ──

/** Extract a human-readable summary from a tool's input JSON (may be partial/incomplete). */
/** Shorten absolute paths to relative-ish display: /home/fonz/Botverse/KYO/src/foo.ts → KYO/src/foo.ts */
function shortenPath(p: string): string {
  // Strip common prefixes
  return p
    .replace(/^\/home\/[^/]+\/Botverse\//, '')
    .replace(/^\/home\/[^/]+\/Projects\//, '')
    .replace(/^\/home\/[^/]+\//, '~/');
}

function extractToolInputSummary(toolName: string, inputJson: string, maxLen = 120, requireComplete = false): string | null {
  if (!inputJson) return null;

  // Determine which field(s) to look for based on tool name
  const fieldsByTool: Record<string, string[]> = {
    Bash:       ['command'],
    Read:       ['file_path', 'path'],
    Write:      ['file_path', 'path'],
    Edit:       ['file_path', 'path'],
    MultiEdit:  ['file_path', 'path'],
    Search:     ['pattern', 'query'],
    Grep:       ['pattern', 'query'],
    Glob:       ['pattern'],
    TodoWrite:  [],  // handled specially below
    TaskOutput: [],  // handled specially below
  };

  const skipTools = new Set(['TodoRead']);
  if (skipTools.has(toolName)) return null;

  const fields = fieldsByTool[toolName];

  const isPathTool = ['Read', 'Write', 'Edit', 'MultiEdit'].includes(toolName);

  // Try parsing complete JSON first
  try {
    const parsed = JSON.parse(inputJson);

    // TaskOutput: show task ID compactly
    if (toolName === 'TaskOutput' && parsed.task_id) {
      return `collecting result · ${String(parsed.task_id).slice(0, 7)}`;
    }

    // TodoWrite: show in-progress item or summary
    if (toolName === 'TodoWrite' && Array.isArray(parsed.todos)) {
      const todos = parsed.todos as Array<{ content?: string; status?: string }>;
      const inProgress = todos.find(t => t.status === 'in_progress');
      const item = inProgress ?? todos[todos.length - 1];
      const total = todos.length;
      const done = todos.filter(t => t.status === 'completed').length;
      const label = item?.content?.trim() ?? '';
      const prefix = `[${done}/${total}] `;
      const combined = prefix + label;
      return combined.length > maxLen ? combined.slice(0, maxLen) + '…' : combined;
    }

    if (fields) {
      for (const f of fields) {
        if (typeof parsed[f] === 'string' && parsed[f].trim()) {
          let val = parsed[f].trim();
          if (isPathTool) val = shortenPath(val);
          return val.length > maxLen ? val.slice(0, maxLen) + '…' : val;
        }
      }
    }
    // Default: first string value
    for (const val of Object.values(parsed)) {
      if (typeof val === 'string' && val.trim()) {
        const v = val.trim();
        return v.length > maxLen ? v.slice(0, maxLen) + '…' : v;
      }
    }
    return null;
  } catch {
    if (requireComplete) return null; // Only use fully-parsed JSON when requireComplete
    // Partial JSON — regex extraction (only used for final resolve, not live preview)
    const targetFields = fields ?? ['command', 'file_path', 'path', 'pattern', 'query'];
    for (const key of targetFields) {
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i'); // require closing quote
      const m = inputJson.match(re);
      if (m?.[1]) {
        let val = m[1].replace(/\\n/g, ' ').replace(/\\t/g, '  ').replace(/\\"/g, '"');
        if (isPathTool) val = shortenPath(val);
        return val.length > maxLen ? val.slice(0, maxLen) + '…' : val;
      }
    }
    return null;
  }
}

/** Extract a compact stat from a tool result for display in the indicator. */
function extractToolResultStat(toolName: string, content?: string, toolUseResult?: Record<string, unknown>): string {
  // For Edit/Write: use structured patch data if available
  if (toolUseResult && (toolName === 'Edit' || toolName === 'MultiEdit')) {
    const patches = toolUseResult.structuredPatch as Array<{ lines?: string[] }> | undefined;
    if (patches?.length) {
      let added = 0, removed = 0;
      for (const patch of patches) {
        if (patch.lines) {
          for (const line of patch.lines) {
            if (line.startsWith('+') && !line.startsWith('+++')) added++;
            else if (line.startsWith('-') && !line.startsWith('---')) removed++;
          }
        }
      }
      if (added || removed) {
        const parts: string[] = [];
        if (added) parts.push(`+${added}`);
        if (removed) parts.push(`-${removed}`);
        return parts.join(' / ');
      }
    }
  }

  if (toolUseResult && toolName === 'Write') {
    const c = toolUseResult.content as string | undefined;
    if (c) {
      const lines = c.split('\n').length;
      return `${lines} lines`;
    }
  }

  if (!content) return '';
  const first = content.split('\n')[0].trim();

  // Skip generic "The file X has been updated/created" messages
  if (/^(The file |File created|Successfully)/.test(first)) {
    // Try to extract something useful anyway
    const lines = content.match(/(\d+)\s*lines?/i);
    if (lines) return `${lines[1]} lines`;
    return '';
  }

  switch (toolName) {
    case 'Write': {
      const lines = content.match(/(\d+)\s*lines?/i);
      const bytes = content.match(/(\d[\d,.]*)\s*(bytes?|KB|MB)/i);
      if (lines) return `${lines[1]} lines`;
      if (bytes) return `${bytes[1]} ${bytes[2]}`;
      return '';
    }
    case 'Edit':
    case 'MultiEdit': {
      const replaced = content.match(/replaced\s+(\d+)\s*lines?/i);
      const chars = content.match(/(\d+)\s*characters?/i);
      if (replaced) return `${replaced[1]} lines replaced`;
      if (chars) return `${chars[1]} chars changed`;
      return '';
    }
    case 'Bash': {
      const exit = content.match(/exit\s*code\s*[:=]?\s*(\d+)/i);
      if (exit && exit[1] !== '0') return `exit ${exit[1]}`;
      const outputLines = content.split('\n').filter(l => l.trim()).length;
      if (outputLines > 3) return `${outputLines} lines output`;
      return first.length > 60 ? first.slice(0, 60) + '…' : first;
    }
    case 'Read': {
      const lines = content.split('\n').length;
      return `${lines} lines`;
    }
    case 'Search':
    case 'Grep':
    case 'Glob': {
      const matches = content.match(/(\d+)\s*(match|result|file)/i);
      if (matches) return `${matches[1]} ${matches[2]}s`;
      const resultLines = content.split('\n').filter(l => l.trim()).length;
      return `${resultLines} results`;
    }
    default:
      return '';
  }
}

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
export function formatUsageFooter(usage: TurnUsage, _model?: string): string {
  // Use per-API-call ctx tokens (from message_start) for context % — these are bounded by the
  // context window. Fall back to cumulative result event tokens only if ctx tokens unavailable.
  const ctxInput = usage.ctxInputTokens ?? usage.inputTokens;
  const ctxRead = usage.ctxCacheReadTokens ?? usage.cacheReadTokens;
  const ctxCreation = usage.ctxCacheCreationTokens ?? usage.cacheCreationTokens;
  const totalCtx = ctxInput + ctxRead + ctxCreation;
  const CONTEXT_WINDOW = 200_000;
  const ctxPct = Math.round(totalCtx / CONTEXT_WINDOW * 100);
  const overLimit = ctxPct > 90;
  const parts = [
    `↩️ ${formatTokens(usage.inputTokens)} in`,
    `${formatTokens(usage.outputTokens)} out`,
  ];
  if (usage.costUsd != null) {
    parts.push(`$${usage.costUsd.toFixed(4)}`);
  }
  parts.push(overLimit ? `⚠️ ${ctxPct}%` : `${ctxPct}%`);
  return `<i>${parts.join(' · ')}</i>`;
}

// ── Sub-agent detection patterns ──

const CC_SUB_AGENT_TOOLS = new Set([
  'Task',           // Primary CC spawning tool
  'dispatch_agent', // Legacy/alternative tool
  'create_agent',   // Test compatibility
  'AgentRunner'     // Test compatibility
]);

export function isSubAgentTool(toolName: string): boolean {
  return CC_SUB_AGENT_TOOLS.has(toolName);
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

/** Label fields in priority order (index 0 = highest priority). */
const LABEL_FIELDS = ['name', 'description', 'subagent_type', 'team_name'] as const;

/** Priority index for a label source field. Lower = better. */
export function labelFieldPriority(field: string | null): number {
  if (!field) return LABEL_FIELDS.length + 1; // worst
  const idx = LABEL_FIELDS.indexOf(field as typeof LABEL_FIELDS[number]);
  return idx >= 0 ? idx : LABEL_FIELDS.length;
}

/**
 * Extract a human-readable label for a sub-agent from its JSON tool input.
 * Returns { label, field } so callers can track priority and upgrade labels
 * when higher-priority fields become available during streaming.
 */
export function extractAgentLabel(jsonInput: string): { label: string; field: string | null } {
  const summaryField = 'prompt'; // last resort — first line of prompt

  try {
    const parsed = JSON.parse(jsonInput);
    for (const key of LABEL_FIELDS) {
      const val = parsed[key];
      if (typeof val === 'string' && val.trim()) {
        return { label: val.trim().slice(0, 80), field: key };
      }
    }
    if (typeof parsed[summaryField] === 'string' && parsed[summaryField].trim()) {
      const firstLine = parsed[summaryField].trim().split('\n')[0];
      const label = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
      return { label, field: 'prompt' };
    }
    return { label: '', field: null };
  } catch {
    // JSON incomplete during streaming — extract first complete field value
    const result = extractFieldFromPartialJsonWithField(jsonInput, LABEL_FIELDS as unknown as string[]);
    return result ?? { label: '', field: null };
  }
}

/** Extract the first complete string value for any of the given keys from partial JSON.
 *  Returns { label, field } so callers know which field matched. */
function extractFieldFromPartialJsonWithField(input: string, keys: string[]): { label: string; field: string } | null {
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
        if (value.trim()) return { label: value.trim().slice(0, 80), field: key };
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
  labelField: string | null;  // which JSON field the label came from (for priority upgrades)
  agentName: string;  // CC's agent name (used as 'from' in mailbox)
  inputPreview: string;
  dispatchedAt: number | null;         // timestamp when dispatched
}

export interface SubAgentSender {
  sendMessage(chatId: number | string, text: string, parseMode?: string): Promise<number>;
  editMessage(chatId: number | string, messageId: number, text: string, parseMode?: string): Promise<void>;
  setReaction?(chatId: number | string, messageId: number, emoji: string): Promise<void>;
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
  private consolidatedAgentMsgId: number | null = null;     // shared TG message for all sub-agents
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
      const label = info.label || info.toolName;
      const text = `✅ ${escapeHtml(label)} — see main message`;
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          await this.sender.editMessage(this.chatId, info.tgMessageId!, text, 'HTML');
        } catch (err) {
          // Non-critical — edit failure on dispatched agent status
        }
      }).catch(() => {});
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
  /** Set agent metadata from structured tool_use_result */
  setAgentMetadata(toolUseId: string, meta: { agentName?: string; agentType?: string; color?: string }): void {
    const info = this.agents.get(toolUseId);
    if (!info) return;
    if (meta.agentName) info.agentName = meta.agentName;
  }

  /** Mark an agent as completed externally (e.g. from bridge follow-up) */
  markCompleted(toolUseId: string, _reason: string): void {
    const info = this.agents.get(toolUseId);
    if (!info || info.status === 'completed') return;
    info.status = 'completed';

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

      this.updateConsolidatedAgentMessage();
      return;
    }

        // Skip if already completed (e.g. via mailbox)
    if (info.status === 'completed') return;

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
        // Edit failure on tool result — non-critical
      }
    }).catch(() => {});
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
      labelField: null,
      agentName: '',
      inputPreview: '',
      dispatchedAt: null,
    };

    this.agents.set(block.id, info);
    this.blockToAgent.set(event.index, block.id);

    // Consolidate all sub-agent indicators into one shared message.
    // If a consolidated message already exists, reuse it; otherwise create one.
    if (this.consolidatedAgentMsgId) {
      info.tgMessageId = this.consolidatedAgentMsgId;
      this.updateConsolidatedAgentMessage();
    } else {
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          const msgId = await this.sender.sendMessage(
            this.chatId,
            '🤖 Starting sub-agent…',
            'HTML',
          );
          info.tgMessageId = msgId;
          this.consolidatedAgentMsgId = msgId;
        } catch {
          // Sub-agent indicator is non-critical
        }
      }).catch(() => {});
      await this.sendQueue;
    }
  }

  /** Build and edit the shared sub-agent status message. */
  private updateConsolidatedAgentMessage(): void {
    if (!this.consolidatedAgentMsgId) return;
    const msgId = this.consolidatedAgentMsgId;
    const lines: string[] = [];
    for (const info of this.agents.values()) {
      const label = info.label || info.agentName || info.toolName;
      const status = info.status === 'completed' ? '✅ Done'
        : info.status === 'dispatched' ? 'Waiting for results…'
        : 'Working…';
      lines.push(`🤖 ${escapeHtml(label)} — ${status}`);
    }
    const text = lines.join('\n');
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(this.chatId, msgId, text, 'HTML');
      } catch {
        // Consolidated message edit failure — non-critical
      }
    }).catch(() => {});
  }

  private async onInputDelta(event: StreamInputJsonDelta): Promise<void> {
    const toolUseId = this.blockToAgent.get(event.index);
    if (!toolUseId) return;

    const info = this.agents.get(toolUseId);
    if (!info || !info.tgMessageId) return;

    if (info.inputPreview.length < 10_000) {
      info.inputPreview += event.delta.partial_json;
    }

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

    // Try to extract an agent label — keep trying for higher-priority fields
    // (e.g., upgrade from subagent_type "general-purpose" to description "Fix the bug")
    const extracted = extractAgentLabel(info.inputPreview);
    if (extracted.label && labelFieldPriority(extracted.field) < labelFieldPriority(info.labelField)) {
      info.label = extracted.label;
      info.labelField = extracted.field;
      this.updateConsolidatedAgentMessage();
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

    // Final chance to extract label from complete input (may upgrade to higher-priority field)
    const finalExtracted = extractAgentLabel(info.inputPreview);
    if (finalExtracted.label && labelFieldPriority(finalExtracted.field) < labelFieldPriority(info.labelField)) {
      info.label = finalExtracted.label;
      info.labelField = finalExtracted.field;
    }

    this.updateConsolidatedAgentMessage();

    // Start elapsed timer — update every 15s to show progress

  }

  /** Start a periodic timer that edits the message with elapsed time */
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

      // Match msg.from to a tracked sub-agent
      const matched = this.findAgentByFrom(msg.from);
      if (!matched) {
        console.error(`[MAILBOX] No match for from="${msg.from}". Agents: ${[...this.agents.values()].map(a => `${a.agentName}/${a.label}/${a.status}`).join(', ')}`);
        continue;
      }

      matched.status = 'completed';

      if (!matched.tgMessageId) continue;

      // React with ✅ instead of editing — avoids race conditions
      const msgId = matched.tgMessageId;
      const emoji = msg.color === 'red' ? '👎' : '👍';
      this.sendQueue = this.sendQueue.then(async () => {
        try {
          await this.sender.setReaction?.(this.chatId, msgId, emoji);
        } catch {
          // Reaction failure — non-critical, might not be supported
        }
      }).catch(() => {});
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

  /** Handle a system task_started event — update the sub-agent status display. */
  handleTaskStarted(toolUseId: string, description: string, taskType?: string): void {
    const info = this.agents.get(toolUseId);
    if (!info) return;

    // Use task_started description as label if we don't have one yet or current is low-priority
    if (description && labelFieldPriority('description') < labelFieldPriority(info.labelField)) {
      info.label = description.slice(0, 80);
      info.labelField = 'description';
    }

    info.status = 'dispatched';
    if (!info.dispatchedAt) info.dispatchedAt = Date.now();
    this.updateConsolidatedAgentMessage();
  }

  /** Handle a system task_progress event — update the sub-agent status with current activity. */
  handleTaskProgress(toolUseId: string, description: string, lastToolName?: string): void {
    const info = this.agents.get(toolUseId);
    if (!info) return;
    if (info.status === 'completed') return; // Don't update completed agents

    // Update the consolidated message with progress info
    this.updateConsolidatedAgentMessageWithProgress(toolUseId, description, lastToolName);
  }

  /** Handle a system task_completed event. */
  handleTaskCompleted(toolUseId: string): void {
    const info = this.agents.get(toolUseId);
    if (!info || info.status === 'completed') return;

    info.status = 'completed';
    this.updateConsolidatedAgentMessage();

    // Check if all agents are done
    const allDone = ![...this.agents.values()].some(a => a.status === 'dispatched');
    if (allDone && this.onAllReported) {
      this.onAllReported();
      this.stopMailboxWatch();
    }
  }

  /** Build and edit the shared sub-agent status message with progress info. */
  private updateConsolidatedAgentMessageWithProgress(progressToolUseId: string, progressDesc: string, lastTool?: string): void {
    if (!this.consolidatedAgentMsgId) return;
    const msgId = this.consolidatedAgentMsgId;
    const lines: string[] = [];
    for (const info of this.agents.values()) {
      const label = info.label || info.agentName || info.toolName;
      if (info.toolUseId === progressToolUseId && info.status !== 'completed') {
        const toolInfo = lastTool ? ` (${lastTool})` : '';
        const desc = progressDesc ? `: ${progressDesc.slice(0, 60)}` : '';
        lines.push(`🤖 ${escapeHtml(label)} — Working${toolInfo}${desc}`);
      } else {
        const status = info.status === 'completed' ? '✅ Done'
          : info.status === 'dispatched' ? 'Waiting for results…'
          : 'Working…';
        lines.push(`🤖 ${escapeHtml(label)} — ${status}`);
      }
    }
    const text = lines.join('\n');
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(this.chatId, msgId, text, 'HTML');
      } catch {
        // Progress message edit failure — non-critical
      }
    }).catch(() => {});
  }

  /** Find a tracked sub-agent by tool_use_id. */
  getAgentByToolUseId(toolUseId: string): SubAgentInfo | undefined {
    return this.agents.get(toolUseId);
  }

  reset(): void {
    // Stop mailbox watching
    this.stopMailboxWatch();
    // Clear all elapsed timers before resetting
    for (const info of this.agents.values()) {
  
    }
    this.agents.clear();
    this.blockToAgent.clear();
    this.consolidatedAgentMsgId = null;
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
