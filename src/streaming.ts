import type {
  StreamInnerEvent,
  StreamContentBlockStart,
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

// ── Markdown safety ──

export function makeMarkdownSafe(text: string): string {
  // Count unclosed triple backticks
  const tripleBackticks = (text.match(/```/g) ?? []).length;
  let safe = text;
  if (tripleBackticks % 2 !== 0) {
    safe += '\n```';
  }

  // Count unclosed single backticks (but not triple)
  const withoutTriple = safe.replace(/```/g, '');
  const singleBackticks = (withoutTriple.match(/`/g) ?? []).length;
  if (singleBackticks % 2 !== 0) {
    safe += '`';
  }

  return safe;
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
        // Response begins — reset state
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
        await this.sendOrEdit('_Thinking..._');
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

  private async sendOrEdit(text: string): Promise<void> {
    const safeText = makeMarkdownSafe(text) || '...';
    try {
      if (!this.tgMessageId) {
        this.tgMessageId = await this.sender.sendMessage(this.chatId, safeText, 'Markdown');
        this.messageIds.push(this.tgMessageId);
      } else {
        await this.sender.editMessage(this.chatId, this.tgMessageId, safeText, 'Markdown');
      }
      this.lastEditTime = Date.now();
    } catch (err: unknown) {
      // Handle TG rate limit (429)
      if (err && typeof err === 'object' && 'error_code' in err && (err as { error_code: number }).error_code === 429) {
        const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5;
        this.editIntervalMs = Math.min(this.editIntervalMs * 2, 5000);
        await sleep(retryAfter * 1000);
        return this.sendOrEdit(text);
      }
      // Ignore "message is not modified" errors
      if (err instanceof Error && err.message.includes('message is not modified')) return;
      throw err;
    }
  }

  private async showToolIndicator(toolName: string): Promise<void> {
    const indicator = this.buffer
      ? `${this.buffer}\n\n_Using ${toolName}..._`
      : `_Using ${toolName}..._`;
    await this.sendOrEdit(indicator);
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

  reset(): void {
    this.tgMessageId = null;
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
