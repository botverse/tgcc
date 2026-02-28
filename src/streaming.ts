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
  setReaction?(chatId: number | string, messageId: number, emoji: string): Promise<void>;
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
  splitThreshold?: number;       // char count to trigger message split (default 3500)
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

/** Create visually distinct system message with enhanced styling */
export function formatSystemMessage(type: 'thinking' | 'tool' | 'usage' | 'error' | 'status', content: string, expandable = false): string {
  const emoji = { thinking: '💭', tool: '⚡', usage: '📊', error: '⚠️', status: 'ℹ️' }[type];
  const wrapper = expandable ? 'blockquote expandable' : 'blockquote';
  return `<${wrapper}>${emoji} ${content}</${wrapper.split(' ')[0]}>`;
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

// ── Segment types (internal) ──

type InternalSegment =
  | { type: 'thinking'; content: string; rawText: string }
  | { type: 'text'; content: string; rawText: string }
  | { type: 'tool'; id: string; content: string; toolName: string; status: 'pending' | 'resolved' | 'error'; inputPreview?: string; elapsed?: string; resultStat?: string; startTime: number }
  | { type: 'subagent'; id: string; content: string; toolName: string; label: string; status: 'running' | 'dispatched' | 'completed'; inputPreview?: string; startTime: number; progressLines: string[] }
  | { type: 'supervisor'; content: string }
  | { type: 'usage'; content: string }
  | { type: 'image'; content: string };  // image block placeholder (no visible segment)

/** Render a single segment to its HTML string. */
function renderSegment(seg: InternalSegment): string {
  switch (seg.type) {
    case 'thinking':
      return `<blockquote expandable>💭 ${seg.rawText ? markdownToTelegramHtml(seg.rawText.length > 1024 ? seg.rawText.slice(0, 1024) + '…' : seg.rawText) : 'Processing…'}</blockquote>`;

    case 'text':
      return seg.rawText ? makeHtmlSafe(seg.rawText) : '';

    case 'tool': {
      if (seg.status === 'resolved') {
        const statPart = seg.resultStat ? ` · <code>${escapeHtml(seg.resultStat)}</code>` : (seg.inputPreview ? ` · <code>${escapeHtml(seg.inputPreview)}</code>` : '');
        return `<blockquote>✅ ${escapeHtml(seg.toolName)} (${seg.elapsed ?? '?'})${statPart}</blockquote>`;
      } else if (seg.status === 'error') {
        return `<blockquote>❌ ${escapeHtml(seg.toolName)} (${seg.elapsed ?? '?'})</blockquote>`;
      } else {
        const previewPart = seg.inputPreview ? ` · <code>${escapeHtml(seg.inputPreview)}</code>` : '…';
        return `<blockquote>⚡ ${escapeHtml(seg.toolName)}${previewPart}</blockquote>`;
      }
    }

    case 'subagent': {
      const label = seg.label || seg.toolName;
      const elapsed = formatElapsed(Date.now() - seg.startTime);
      const progressBlock = seg.progressLines.length > 0
        ? '\n' + seg.progressLines.join('\n')
        : '';
      if (seg.status === 'completed') {
        return `<blockquote>🤖 ${escapeHtml(label)} — ✅ Done (${elapsed})${progressBlock}</blockquote>`;
      } else {
        return `<blockquote>🤖 ${escapeHtml(label)} — Working (${elapsed})…${progressBlock}</blockquote>`;
      }
    }

    case 'supervisor':
    case 'usage':
    case 'image':
      return seg.content;

    default:
      return '';
  }
}

// ── Stream Accumulator (single-bubble FIFO) ──

export class StreamAccumulator {
  private chatId: number | string;
  private sender: TelegramSender;
  private editIntervalMs: number;
  private splitThreshold: number;
  private logger?: { error?: (...args: unknown[]) => void; warn?: (...args: unknown[]) => void; debug?: (...args: unknown[]) => void };
  private onError?: (err: unknown, context: string) => void;

  // Segment FIFO
  private segments: InternalSegment[] = [];

  // State
  private tgMessageId: number | null = null;
  private messageIds: number[] = [];
  sealed = false;
  private sendQueue: Promise<void> = Promise.resolve();
  private turnUsage: TurnUsage | null = null;
  private _lastMsgStartCtx: { input: number; cacheRead: number; cacheCreation: number } | null = null;

  // Per-block streaming state
  private currentBlockType: 'text' | 'thinking' | 'tool_use' | 'image' | null = null;
  private currentBlockId: string | null = null;
  private currentSegmentIdx = -1;  // index into segments[] for currently-building block

  // Tool streaming state
  private toolInputBuffers = new Map<string, string>();  // blockId → accumulated JSON input

  // Image streaming state
  private imageBase64Buffer = '';

  // Rate limiting / render scheduling
  private lastEditTime = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  // Delayed first send (fix: don't create TG message until real content arrives)
  private turnStartTime = 0;
  private firstSendReady = true;  // true until first reset() — pre-turn sends are unrestricted
  private firstSendTimer: ReturnType<typeof setTimeout> | null = null;

  // Tool hide timers (fix: don't flash ⚡ for fast tools that resolve <500ms)
  private toolHideTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: StreamAccumulatorOptions) {
    this.chatId = options.chatId;
    this.sender = options.sender;
    this.editIntervalMs = options.editIntervalMs ?? 1000;
    this.splitThreshold = options.splitThreshold ?? 3500;
    this.logger = options.logger;
    this.onError = options.onError;
  }

  get allMessageIds(): number[] { return [...this.messageIds]; }

  /** Set usage stats for the current turn (called from bridge on result event) */
  setTurnUsage(usage: TurnUsage): void {
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

  /** Append a supervisor message segment. Renders in stream order with everything else. */
  addSupervisorMessage(text: string): void {
    const preview = text.length > 500 ? text.slice(0, 500) + '…' : text;
    const seg: InternalSegment = {
      type: 'supervisor',
      content: `<blockquote>🦞 ${escapeHtml(preview)}</blockquote>`,
    };
    this.segments.push(seg);
    this.requestRender();
  }

  // ── Process stream events ──

  async handleEvent(event: StreamInnerEvent): Promise<void> {
    switch (event.type) {
      case 'message_start': {
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
        this.onContentBlockStart(event as StreamContentBlockStart);
        break;

      case 'content_block_delta':
        await this.onContentBlockDelta(event);
        break;

      case 'content_block_stop':
        await this.onContentBlockStop(event as StreamContentBlockStop);
        break;

      case 'message_stop':
        // message_stop within a tool-use loop — finalize is called separately by bridge on `result`
        break;
    }
  }

  private onContentBlockStart(event: StreamContentBlockStart): void {
    const blockType = event.content_block.type;
    this.currentBlockType = blockType as typeof this.currentBlockType;

    if (blockType === 'thinking') {
      const seg: InternalSegment = { type: 'thinking', rawText: '', content: '' };
      seg.content = renderSegment(seg);
      this.segments.push(seg);
      this.currentSegmentIdx = this.segments.length - 1;
      this.requestRender();

    } else if (blockType === 'text') {
      const seg: InternalSegment = { type: 'text', rawText: '', content: '' };
      this.segments.push(seg);
      this.currentSegmentIdx = this.segments.length - 1;

    } else if (blockType === 'tool_use') {
      const block = event.content_block as { type: 'tool_use'; id: string; name: string };
      this.currentBlockId = block.id;
      this.toolInputBuffers.set(block.id, '');

      if (isSubAgentTool(block.name)) {
        const seg: InternalSegment = {
          type: 'subagent',
          id: block.id,
          toolName: block.name,
          label: '',
          status: 'running',
          startTime: Date.now(),
          progressLines: [],
          content: '',
        };
        seg.content = renderSegment(seg);
        this.segments.push(seg);
        this.currentSegmentIdx = this.segments.length - 1;
      } else {
        const seg: InternalSegment = {
          type: 'tool',
          id: block.id,
          toolName: block.name,
          status: 'pending',
          startTime: Date.now(),
          content: '',
        };
        seg.content = renderSegment(seg);
        this.segments.push(seg);
        this.currentSegmentIdx = this.segments.length - 1;
        // Suppress the ⚡ pending indicator for 500ms. If the tool resolves within that window
        // the hide timer is cancelled in resolveToolMessage and we render directly as ✅.
        const toolBlockId = block.id;
        this.toolHideTimers.set(toolBlockId, setTimeout(() => {
          this.toolHideTimers.delete(toolBlockId);
          this.requestRender();
        }, 500));
      }
      this.requestRender();

    } else if (blockType === 'image') {
      this.imageBase64Buffer = '';
    }
  }

  private async onContentBlockDelta(event: StreamInnerEvent): Promise<void> {
    if (this.currentBlockType === 'text' && 'delta' in event) {
      const delta = (event as StreamTextDelta).delta;
      if (delta?.type === 'text_delta' && this.currentSegmentIdx >= 0) {
        const seg = this.segments[this.currentSegmentIdx] as Extract<InternalSegment, { type: 'text' }>;
        seg.rawText += delta.text;
        seg.content = renderSegment(seg);

        if (seg.rawText.length > 50_000) {
          await this.forceSplitText(seg);
          return;
        }

        this.requestRender();
      }
    } else if (this.currentBlockType === 'thinking' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'thinking_delta' && delta.thinking && this.currentSegmentIdx >= 0) {
        const seg = this.segments[this.currentSegmentIdx] as Extract<InternalSegment, { type: 'thinking' }>;
        seg.rawText += delta.thinking;
        seg.content = renderSegment(seg);
        this.requestRender();
      }
    } else if (this.currentBlockType === 'tool_use' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'input_json_delta' && delta.partial_json && this.currentBlockId) {
        const blockId = this.currentBlockId;
        const prev = this.toolInputBuffers.get(blockId) ?? '';
        const next = prev + delta.partial_json;
        this.toolInputBuffers.set(blockId, next);

        // Update segment preview if we have enough input
        if (this.currentSegmentIdx >= 0) {
          const seg = this.segments[this.currentSegmentIdx];
          if (seg.type === 'tool' || seg.type === 'subagent') {
            const toolName = seg.type === 'tool' ? seg.toolName : seg.toolName;
            const summary = extractToolInputSummary(toolName, next, 80, true);
            if (summary) {
              (seg as any).inputPreview = summary;
            }
            if (seg.type === 'subagent') {
              const extracted = extractAgentLabel(next);
              if (extracted.label && labelFieldPriority(extracted.field) < labelFieldPriority((seg as any).labelField ?? null)) {
                (seg as any).label = extracted.label;
                (seg as any).labelField = extracted.field;
              }
            }
            seg.content = renderSegment(seg);
            this.requestRender();
          }
        }
      }
    } else if (this.currentBlockType === 'image' && 'delta' in event) {
      const delta = (event as any).delta;
      if (delta?.type === 'image_delta' && delta.data) {
        this.imageBase64Buffer += delta.data;
      }
    }
  }

  private async onContentBlockStop(_event: StreamContentBlockStop): Promise<void> {
    if (this.currentBlockType === 'tool_use' && this.currentBlockId && this.currentSegmentIdx >= 0) {
      const blockId = this.currentBlockId;
      const seg = this.segments[this.currentSegmentIdx];
      const inputJson = this.toolInputBuffers.get(blockId) ?? '';

      if (seg.type === 'subagent') {
        // Finalize label from complete input
        const extracted = extractAgentLabel(inputJson);
        if (extracted.label) {
          seg.label = extracted.label;
          (seg as any).labelField = extracted.field;
        }
        // Mark as dispatched (input complete, waiting for tool_result)
        seg.status = 'dispatched';
        seg.content = renderSegment(seg);
        this.requestRender();
      } else if (seg.type === 'tool') {
        // Finalize preview from complete input
        const summary = extractToolInputSummary(seg.toolName, inputJson, 80);
        if (summary) seg.inputPreview = summary;
        seg.content = renderSegment(seg);
        this.requestRender();
      }
    } else if (this.currentBlockType === 'image' && this.imageBase64Buffer) {
      await this.sendImage();
    }

    this.currentBlockType = null;
    this.currentBlockId = null;
    this.currentSegmentIdx = -1;
  }

  // ── Public tool resolution API ──

  /** Resolve a tool indicator with success/failure status. Called by bridge on tool_result. */
  resolveToolMessage(blockId: string, isError: boolean, errorMessage?: string, resultContent?: string, toolUseResult?: Record<string, unknown>): void {
    const segIdx = this.segments.findIndex(s => (s.type === 'tool' || s.type === 'subagent') && (s as any).id === blockId);
    if (segIdx < 0) return;

    const seg = this.segments[segIdx];

    if (seg.type === 'subagent') {
      // Sub-agent spawn confirmation → mark as dispatched/waiting
      const isSpawnConfirmation = toolUseResult?.status === 'teammate_spawned' ||
        (typeof resultContent === 'string' && (/agent_id:\s*\S+@\S+/.test(resultContent) || /[Ss]pawned\s+successfully/i.test(resultContent)));

      if (isSpawnConfirmation) {
        seg.status = 'dispatched';
        seg.content = renderSegment(seg);
        this.requestRender();
        return;
      }

      // Tool result (synchronous completion) → mark completed
      seg.status = 'completed';
      seg.content = renderSegment(seg);
      this.requestRender();
      return;
    }

    if (seg.type === 'tool') {
      // Cancel the hide timer — tool is now visible in its final state.
      // If it resolved within 500ms the timer was still running; cancelling it means
      // the ⚡ pending indicator was never shown and we render directly as ✅.
      const hideTimer = this.toolHideTimers.get(blockId);
      if (hideTimer !== undefined) {
        clearTimeout(hideTimer);
        this.toolHideTimers.delete(blockId);
      }

      // MCP media tools: remove segment on success (media itself is the result)
      if (StreamAccumulator.MCP_MEDIA_TOOLS.has(seg.toolName) && !isError) {
        this.segments.splice(segIdx, 1);
        this.requestRender();
        return;
      }

      const elapsed = ((Date.now() - seg.startTime) / 1000).toFixed(1) + 's';
      seg.elapsed = elapsed;

      if (isError) {
        seg.status = 'error';
      } else {
        seg.status = 'resolved';
        // Finalize input preview from buffer if not set
        const inputJson = this.toolInputBuffers.get(blockId) ?? '';
        if (!seg.inputPreview) {
          const summary = extractToolInputSummary(seg.toolName, inputJson);
          if (summary) seg.inputPreview = summary;
        }
        // Compute result stat
        const resultStat = extractToolResultStat(seg.toolName, resultContent, toolUseResult);
        if (resultStat) seg.resultStat = resultStat;
      }
      this.toolInputBuffers.delete(blockId);
      seg.content = renderSegment(seg);
      this.requestRender();
    }
  }

  /** Update a sub-agent segment status (called by bridge on task_started/progress/completed). */
  updateSubAgentSegment(blockId: string, status: 'running' | 'dispatched' | 'completed', label?: string): void {
    const seg = this.segments.find(s => s.type === 'subagent' && (s as any).id === blockId) as Extract<InternalSegment, { type: 'subagent' }> | undefined;
    if (!seg) return;
    if (seg.status === 'completed') return;  // don't downgrade
    seg.status = status;
    if (label && label.length > seg.label.length) seg.label = label;
    seg.content = renderSegment(seg);
    this.requestRender();
  }

  /** Append a high-signal progress line to a sub-agent segment (called by bridge on task_progress). */
  appendSubAgentProgress(blockId: string, description: string, lastToolName?: string): void {
    const seg = this.segments.find(s => s.type === 'subagent' && (s as any).id === blockId) as Extract<InternalSegment, { type: 'subagent' }> | undefined;
    if (!seg || seg.status === 'completed') return;
    const line = formatProgressLine(description, lastToolName);
    if (!line) return;
    seg.progressLines.push(line);
    if (seg.progressLines.length > MAX_PROGRESS_LINES) seg.progressLines.shift();
    seg.content = renderSegment(seg);
    this.requestRender();
  }

  private static MCP_MEDIA_TOOLS = new Set(['mcp__tgcc__send_image', 'mcp__tgcc__send_file', 'mcp__tgcc__send_voice']);

  // ── Rendering ──

  /** Render all segments to one HTML string. */
  renderHtml(): string {
    const parts = this.segments
      .map(s => {
        // Hide pending tool segments until 500ms has elapsed — fast tools go directly to resolved state
        if (s.type === 'tool' && s.status === 'pending' && this.toolHideTimers.has(s.id)) return '';
        return s.content;
      })
      .filter(c => c.length > 0);
    return parts.join('\n') || '…';
  }

  /** Mark dirty and schedule a throttled flush. The single entry point for all renders.
   *  Data in → dirty flag → throttled flush → TG edit. One path, no re-entrant loops. */
  private requestRender(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      const elapsed = Date.now() - this.lastEditTime;
      const delay = Math.max(0, this.editIntervalMs - elapsed);
      this.flushTimer = setTimeout(() => this.flushRender(), delay);
    }
  }

  /** Timer callback: consumes dirty flag and chains one _doSendOrEdit onto sendQueue. */
  private flushRender(): void {
    this.flushTimer = null;
    if (!this.dirty || this.sealed) return;

    // Gate: delay first TG message until real text content arrives or 2s have passed.
    if (!this.tgMessageId && !this.checkFirstSendReady()) {
      if (!this.firstSendTimer) {
        const remaining = Math.max(0, 2000 - (Date.now() - this.turnStartTime));
        this.firstSendTimer = setTimeout(() => {
          this.firstSendTimer = null;
          this.firstSendReady = true;
          this.requestRender();
        }, remaining);
      }
      // dirty stays true; requestRender() will re-schedule when timer fires
      return;
    }

    this.dirty = false;
    const html = this.renderHtml();

    if (html.length > this.splitThreshold) {
      this.sendQueue = this.sendQueue
        .then(() => this.splitMessage())
        .catch(err => { this.logger?.error?.({ err }, 'flushRender splitMessage failed'); });
    } else {
      this.sendQueue = this.sendQueue
        .then(() => this._doSendOrEdit(html || '…'))
        .catch(err => { this.logger?.error?.({ err }, 'flushRender failed'); });
    }
  }

  /** Split oversized message — called from within the sendQueue chain, uses _doSendOrEdit directly. */
  private async splitMessage(): Promise<void> {
    // Find text segments to split on
    let totalLen = 0;
    let splitSegIdx = -1;

    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      totalLen += seg.content.length + 1;
      if (totalLen > this.splitThreshold && splitSegIdx < 0) {
        splitSegIdx = i;
      }
    }

    if (splitSegIdx <= 0) {
      // Can't split cleanly — truncate the HTML
      const html = this.renderHtml().slice(0, this.splitThreshold);
      await this._doSendOrEdit(html);
      return;
    }

    // Render first part, start new message with remainder
    const firstSegs = this.segments.slice(0, splitSegIdx);
    const restSegs = this.segments.slice(splitSegIdx);

    const firstHtml = firstSegs.map(s => s.content).filter(Boolean).join('\n');
    await this._doSendOrEdit(firstHtml);

    // Start a new message for remainder
    this.tgMessageId = null;
    this.segments = restSegs;
    const restHtml = this.renderHtml();
    await this._doSendOrEdit(restHtml);
  }

  private checkFirstSendReady(): boolean {
    if (this.firstSendReady) return true;
    const textChars = this.segments
      .filter((s): s is Extract<InternalSegment, { type: 'text' }> => s.type === 'text')
      .reduce((sum, s) => sum + s.rawText.length, 0);
    if (textChars >= 200 || Date.now() - this.turnStartTime >= 2000) {
      this.firstSendReady = true;
      this.clearFirstSendTimer();
      return true;
    }
    return false;
  }

  private clearFirstSendTimer(): void {
    if (this.firstSendTimer) {
      clearTimeout(this.firstSendTimer);
      this.firstSendTimer = null;
    }
  }

  /** Force-split when a text segment exceeds 50KB */
  private async forceSplitText(seg: Extract<InternalSegment, { type: 'text' }>): Promise<void> {
    const maxChars = 40_000;
    const splitAt = findSplitPoint(seg.rawText, maxChars);
    const firstPart = seg.rawText.slice(0, splitAt);
    const remainder = seg.rawText.slice(splitAt);

    // Replace the current text segment with truncated first part
    seg.rawText = firstPart;
    seg.content = renderSegment(seg);
    await this.sendOrEdit(this.renderHtml());

    // Start new message for remainder
    this.tgMessageId = null;
    const newSeg: InternalSegment = { type: 'text', rawText: remainder, content: '' };
    newSeg.content = renderSegment(newSeg);
    this.segments = [newSeg];
    this.currentSegmentIdx = 0;
    await this.sendOrEdit(this.renderHtml());
  }

  async finalize(): Promise<void> {
    // Cancel any pending flush — we take over from here
    this.clearFlushTimer();

    // Ensure first send is unblocked — finalize is the last chance to send anything
    this.firstSendReady = true;
    this.clearFirstSendTimer();

    // Append usage footer segment
    if (this.turnUsage) {
      const usageHtml = formatUsageFooter(this.turnUsage, this.turnUsage.model);
      const seg: InternalSegment = { type: 'usage', content: `<blockquote>📊 ${usageHtml}</blockquote>` };
      this.segments.push(seg);
    }

    // Final render — chain directly onto sendQueue so it runs after any in-flight edits
    const html = this.renderHtml();
    if (html && html !== '…') {
      this.sendQueue = this.sendQueue
        .then(() => this._doSendOrEdit(html))
        .catch(err => {
          this.logger?.error?.({ err }, 'finalize failed');
          this.onError?.(err, 'Failed to send/edit message');
        });
      await this.sendQueue;
    }

    this.sealed = true;
  }

  // ── TG message management ──

  private async sendOrEdit(html: string): Promise<void> {
    const safeHtml = html || '…';
    this.sendQueue = this.sendQueue.then(() => this._doSendOrEdit(safeHtml)).catch(err => {
      this.logger?.error?.({ err }, 'sendOrEdit failed');
      this.onError?.(err, 'Failed to send/edit message');
    });
    return this.sendQueue;
  }

  private async _doSendOrEdit(html: string): Promise<void> {
    let text = html || '…';
    if (!text.replace(/<[^>]*>/g, '').trim()) text = '…';

    this.lastEditTime = Date.now();

    try {
      if (!this.tgMessageId) {
        this.tgMessageId = await this.sender.sendMessage(this.chatId, text, 'HTML');
        this.messageIds.push(this.tgMessageId);
      } else {
        await this.sender.editMessage(this.chatId, this.tgMessageId, text, 'HTML');
      }
    } catch (err: unknown) {
      const errorCode = err && typeof err === 'object' && 'error_code' in err
        ? (err as { error_code: number }).error_code : 0;

      if (errorCode === 429) {
        const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters?.retry_after ?? 5;
        this.editIntervalMs = Math.min(this.editIntervalMs * 2, 5000);
        await sleep(retryAfter * 1000);
        return this._doSendOrEdit(text);
      }
      if (err instanceof Error && err.message.includes('message is not modified')) return;
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
      this.logger?.error?.({ err }, 'Failed to send image');
    }
    this.imageBase64Buffer = '';
  }

  /** Soft reset: clear per-API-call transient state. Segments and tgMessageId persist across
   *  tool-use loop iterations within the same turn. */
  softReset(): void {
    this.currentBlockType = null;
    this.currentBlockId = null;
    this.currentSegmentIdx = -1;
    this.sealed = false;
    this.turnUsage = null;
    this._lastMsgStartCtx = null;
    this.clearFlushTimer();
    for (const t of this.toolHideTimers.values()) clearTimeout(t);
    this.toolHideTimers.clear();
  }

  /** Full reset: clear everything for a new turn. */
  reset(): void {
    const prevQueue = this.sendQueue;
    this.softReset();
    this.segments = [];
    this.tgMessageId = null;
    this.messageIds = [];
    this.toolInputBuffers.clear();
    this.imageBase64Buffer = '';
    this.lastEditTime = 0;
    this.dirty = false;
    this.sendQueue = prevQueue.catch(() => {});
    this.turnStartTime = Date.now();
    this.firstSendReady = false;
    this.clearFirstSendTimer();
    for (const t of this.toolHideTimers.values()) clearTimeout(t);
    this.toolHideTimers.clear();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ── Helpers ──

/** Shorten absolute paths to relative-ish display: /home/fonz/Botverse/KYO/src/foo.ts → KYO/src/foo.ts */
function shortenPath(p: string): string {
  return p
    .replace(/^\/home\/[^/]+\/Botverse\//, '')
    .replace(/^\/home\/[^/]+\/Projects\//, '')
    .replace(/^\/home\/[^/]+\//, '~/');
}

function extractToolInputSummary(toolName: string, inputJson: string, maxLen = 120, requireComplete = false): string | null {
  if (!inputJson) return null;

  const fieldsByTool: Record<string, string[]> = {
    Bash:       ['command'],
    Read:       ['file_path', 'path'],
    Write:      ['file_path', 'path'],
    Edit:       ['file_path', 'path'],
    MultiEdit:  ['file_path', 'path'],
    Search:     ['pattern', 'query'],
    Grep:       ['pattern', 'query'],
    Glob:       ['pattern'],
    TodoWrite:  [],
    TaskOutput: [],
  };

  const skipTools = new Set(['TodoRead']);
  if (skipTools.has(toolName)) return null;

  const fields = fieldsByTool[toolName];
  const isPathTool = ['Read', 'Write', 'Edit', 'MultiEdit'].includes(toolName);

  try {
    const parsed = JSON.parse(inputJson);

    if (toolName === 'TaskOutput' && parsed.task_id) {
      return `collecting result · ${String(parsed.task_id).slice(0, 7)}`;
    }

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
    for (const val of Object.values(parsed)) {
      if (typeof val === 'string' && val.trim()) {
        const v = val.trim();
        return v.length > maxLen ? v.slice(0, maxLen) + '…' : v;
      }
    }
    return null;
  } catch {
    if (requireComplete) return null;
    const targetFields = fields ?? ['command', 'file_path', 'path', 'pattern', 'query'];
    for (const key of targetFields) {
      const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i');
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

function extractToolResultStat(toolName: string, content?: string, toolUseResult?: Record<string, unknown>): string {
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
    if (c) return `${c.split('\n').length} lines`;
  }

  if (!content) return '';
  const first = content.split('\n')[0].trim();

  if (/^(The file |File created|Successfully)/.test(first)) {
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
  const paragraphBreak = text.lastIndexOf('\n\n', threshold);
  if (paragraphBreak > threshold * 0.5) return paragraphBreak;

  const lineBreak = text.lastIndexOf('\n', threshold);
  if (lineBreak > threshold * 0.5) return lineBreak;

  const sentenceEnd = text.lastIndexOf('. ', threshold);
  if (sentenceEnd > threshold * 0.5) return sentenceEnd + 2;

  return threshold;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const MAX_PROGRESS_LINES = 5;

/** Format a task_progress event into a single HTML-safe progress line.
 *  Returns null if the event has no useful display content. */
export function formatProgressLine(description: string, lastToolName?: string): string | null {
  const desc = description?.trim();
  if (!desc) return null;

  const lower = desc.toLowerCase();
  const tool = lastToolName?.toLowerCase() ?? '';

  let emoji = '📋';
  if (tool === 'bash' && /build|compile|npm run|pnpm|yarn|make/.test(lower)) {
    emoji = '🔨';
  } else if (tool === 'bash' && /git commit|git push/.test(lower)) {
    emoji = '📝';
  } else if (/context.*%|%.*context|\d{2,3}%/.test(lower)) {
    emoji = '🧠';
  }

  const truncated = desc.length > 60 ? desc.slice(0, 60) + '…' : desc;
  return `${emoji} ${escapeHtml(truncated)}`;
}

function formatTokens(n: number): string {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/** Format usage stats as an HTML italic footer line */
export function formatUsageFooter(usage: TurnUsage, _model?: string): string {
  const ctxInput = usage.ctxInputTokens ?? usage.inputTokens;
  const ctxRead = usage.ctxCacheReadTokens ?? usage.cacheReadTokens;
  const ctxCreation = usage.ctxCacheCreationTokens ?? usage.cacheCreationTokens;
  const totalCtx = ctxInput + ctxRead + ctxCreation;
  const CONTEXT_WINDOW = 200_000;
  const ctxPct = Math.round(totalCtx / CONTEXT_WINDOW * 100);
  const overLimit = ctxPct > 90;
  const parts = [
    `${formatTokens(usage.inputTokens)} in`,
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
  'Task',
  'dispatch_agent',
  'create_agent',
  'AgentRunner'
]);

export function isSubAgentTool(toolName: string): boolean {
  return CC_SUB_AGENT_TOOLS.has(toolName);
}

export function extractSubAgentSummary(jsonInput: string, maxLen = 150): string {
  try {
    const parsed = JSON.parse(jsonInput);
    const value = parsed.prompt || parsed.task || parsed.command || parsed.description || parsed.message || '';
    if (typeof value === 'string' && value.length > 0) {
      return value.length > maxLen ? value.slice(0, maxLen) + '…' : value;
    }
  } catch {
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

const LABEL_FIELDS = ['name', 'description', 'subagent_type', 'team_name'] as const;

export function labelFieldPriority(field: string | null): number {
  if (!field) return LABEL_FIELDS.length + 1;
  const idx = LABEL_FIELDS.indexOf(field as typeof LABEL_FIELDS[number]);
  return idx >= 0 ? idx : LABEL_FIELDS.length;
}

export function extractAgentLabel(jsonInput: string): { label: string; field: string | null } {
  const summaryField = 'prompt';

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
    const result = extractFieldFromPartialJsonWithField(jsonInput, LABEL_FIELDS as unknown as string[]);
    return result ?? { label: '', field: null };
  }
}

function extractFieldFromPartialJsonWithField(input: string, keys: string[]): { label: string; field: string } | null {
  for (const key of keys) {
    const idx = input.indexOf(`"${key}"`);
    if (idx === -1) continue;
    const afterKey = input.slice(idx + key.length + 2);
    const colonIdx = afterKey.indexOf(':');
    if (colonIdx === -1) continue;
    const afterColon = afterKey.slice(colonIdx + 1).trimStart();
    if (!afterColon.startsWith('"')) continue;
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
  labelField: string | null;
  agentName: string;
  inputPreview: string;
  startTime: number;
  dispatchedAt: number | null;
  progressLines: string[];
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

export interface MailboxMessage {
  from: string;
  text: string;
  summary: string;
  timestamp: string;
  color?: string;
  read: boolean;
}

export type AllAgentsReportedCallback = () => void;

export class SubAgentTracker {
  private chatId: number | string;
  private sender: SubAgentSender;
  private agents = new Map<string, SubAgentInfo>();
  private blockToAgent = new Map<number, string>();
  private standaloneMsgId: number | null = null;  // post-turn standalone status bubble
  private sendQueue: Promise<void> = Promise.resolve();
  private teamName: string | null = null;
  private mailboxPath: string | null = null;
  private mailboxWatching = false;
  private lastMailboxCount = 0;
  private onAllReported: AllAgentsReportedCallback | null = null;
  hasPendingFollowUp = false;

  /** When true, stream events update agent metadata but do NOT create TG messages.
   *  Set to false after the main turn bubble is sealed to allow standalone status bubble. */
  private inTurn = true;

  constructor(options: SubAgentTrackerOptions) {
    this.chatId = options.chatId;
    this.sender = options.sender;
  }

  get activeAgents(): SubAgentInfo[] {
    return [...this.agents.values()];
  }

  get hadSubAgents(): boolean {
    return this.agents.size > 0;
  }

  get hasDispatchedAgents(): boolean {
    return [...this.agents.values()].some(a => a.status === 'dispatched');
  }

  /** Called after the main bubble is sealed. Creates standalone status bubble for any dispatched agents. */
  async startPostTurnTracking(): Promise<void> {
    this.inTurn = false;
    if (!this.hasDispatchedAgents) return;

    // Create the standalone status bubble
    const html = this.buildStandaloneHtml();
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        const msgId = await this.sender.sendMessage(this.chatId, html, 'HTML');
        this.standaloneMsgId = msgId;
        // Set tgMessageId on all dispatched agents pointing to this standalone bubble
        for (const info of this.agents.values()) {
          if (info.status === 'dispatched') {
            info.tgMessageId = msgId;
          }
        }
      } catch {
        // Non-critical
      }
    }).catch(() => {});
    await this.sendQueue;
  }

  markDispatchedAsReportedInMain(): void {
    for (const [, info] of this.agents) {
      if (info.status !== 'dispatched') continue;
      info.status = 'completed';
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
    }
  }

  setAgentMetadata(toolUseId: string, meta: { agentName?: string; agentType?: string; color?: string }): void {
    const info = this.agents.get(toolUseId);
    if (!info) return;
    if (meta.agentName) info.agentName = meta.agentName;
  }

  markCompleted(toolUseId: string, _reason: string): void {
    const info = this.agents.get(toolUseId);
    if (!info || info.status === 'completed') return;
    info.status = 'completed';

    if (!this.inTurn) this.updateStandaloneMessage();

    const allDone = ![...this.agents.values()].some(a => a.status === 'dispatched');
    if (allDone && this.onAllReported) {
      this.onAllReported();
      this.stopMailboxWatch();
    }
  }

  async handleToolResult(toolUseId: string, result: string): Promise<void> {
    const info = this.agents.get(toolUseId);
    if (!info) return;

    const isSpawnConfirmation = /agent_id:\s*\S+@\S+/.test(result) || /[Ss]pawned\s+successfully/i.test(result);

    if (isSpawnConfirmation) {
      const nameMatch = result.match(/name:\s*(\S+)/);
      if (nameMatch && !info.agentName) info.agentName = nameMatch[1];
      const agentIdMatch = result.match(/agent_id:\s*(\S+)@/);
      if (agentIdMatch && !info.agentName) info.agentName = agentIdMatch[1];
      info.status = 'dispatched';
      info.dispatchedAt = Date.now();
      if (!this.inTurn) this.updateStandaloneMessage();
      return;
    }

    if (info.status === 'completed') return;
    info.status = 'completed';
    if (!this.inTurn) this.updateStandaloneMessage();
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
      startTime: Date.now(),
      dispatchedAt: null,
      progressLines: [],
    };

    this.agents.set(block.id, info);
    this.blockToAgent.set(event.index, block.id);
    // During the turn, StreamAccumulator renders the sub-agent segment.
    // Tracker only manages metadata here (no TG message).
  }

  private async onInputDelta(event: StreamInputJsonDelta): Promise<void> {
    const toolUseId = this.blockToAgent.get(event.index);
    if (!toolUseId) return;

    const info = this.agents.get(toolUseId);
    if (!info) return;

    if (info.inputPreview.length < 10_000) {
      info.inputPreview += event.delta.partial_json;
    }

    // Extract agent name for mailbox matching
    if (!info.agentName) {
      try {
        const parsed = JSON.parse(info.inputPreview);
        if (typeof parsed.name === 'string' && parsed.name.trim()) {
          info.agentName = parsed.name.trim();
        }
      } catch {
        const nameMatch = info.inputPreview.match(/"name"\s*:\s*"([^"]+)"/);
        if (nameMatch) info.agentName = nameMatch[1];
      }
    }

    // Extract label for standalone bubble (used post-turn)
    const extracted = extractAgentLabel(info.inputPreview);
    if (extracted.label && labelFieldPriority(extracted.field) < labelFieldPriority(info.labelField)) {
      info.label = extracted.label;
      info.labelField = extracted.field;
    }
  }

  private async onBlockStop(event: StreamContentBlockStop): Promise<void> {
    const toolUseId = this.blockToAgent.get(event.index);
    if (!toolUseId) return;

    const info = this.agents.get(toolUseId);
    if (!info) return;

    info.status = 'dispatched';
    info.dispatchedAt = Date.now();

    const finalExtracted = extractAgentLabel(info.inputPreview);
    if (finalExtracted.label && labelFieldPriority(finalExtracted.field) < labelFieldPriority(info.labelField)) {
      info.label = finalExtracted.label;
      info.labelField = finalExtracted.field;
    }
  }

  setOnAllReported(cb: AllAgentsReportedCallback | null): void {
    this.onAllReported = cb;
  }

  setTeamName(name: string): void {
    this.teamName = name;
    this.mailboxPath = join(
      homedir(),
      '.claude', 'teams', name, 'inboxes', 'team-lead.json',
    );
  }

  get currentTeamName(): string | null { return this.teamName; }
  get isMailboxWatching(): boolean { return this.mailboxWatching; }

  startMailboxWatch(): void {
    if (this.mailboxWatching) return;
    if (!this.mailboxPath) return;

    this.mailboxWatching = true;

    const dir = dirname(this.mailboxPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.lastMailboxCount = 0;
    this.processMailbox();

    watchFile(this.mailboxPath, { interval: 2000 }, () => {
      this.processMailbox();
    });
  }

  stopMailboxWatch(): void {
    if (!this.mailboxWatching || !this.mailboxPath) return;
    try {
      unwatchFile(this.mailboxPath);
    } catch { /* ignore */ }
    this.mailboxWatching = false;
  }

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

  private processMailbox(): void {
    const messages = this.readMailboxMessages();
    if (messages.length <= this.lastMailboxCount) return;

    const newMessages = messages.slice(this.lastMailboxCount);
    this.lastMailboxCount = messages.length;

    for (const msg of newMessages) {
      if (msg.text.startsWith('{')) continue;

      const matched = this.findAgentByFrom(msg.from);
      if (!matched) {
        console.error(`[MAILBOX] No match for from="${msg.from}". Agents: ${[...this.agents.values()].map(a => `${a.agentName}/${a.label}/${a.status}`).join(', ')}`);
        continue;
      }

      matched.status = 'completed';

      // Update standalone bubble or set reaction on its message
      if (!this.inTurn && this.standaloneMsgId) {
        this.updateStandaloneMessage();
        // Also react on the standalone bubble
        const msgId = this.standaloneMsgId;
        const emoji = msg.color === 'red' ? '👎' : '👍';
        this.sendQueue = this.sendQueue.then(async () => {
          try {
            await this.sender.setReaction?.(this.chatId, msgId, emoji);
          } catch { /* non-critical */ }
        }).catch(() => {});
      } else if (matched.tgMessageId) {
        const msgId = matched.tgMessageId;
        const emoji = msg.color === 'red' ? '👎' : '👍';
        this.sendQueue = this.sendQueue.then(async () => {
          try {
            await this.sender.setReaction?.(this.chatId, msgId, emoji);
          } catch { /* non-critical */ }
        }).catch(() => {});
      }
    }

    if (this.onAllReported && !this.hasDispatchedAgents && this.agents.size > 0) {
      const cb = this.onAllReported;
      setTimeout(() => cb(), 500);
    }
  }

  private findAgentByFrom(from: string): SubAgentInfo | null {
    const fromLower = from.toLowerCase();
    for (const info of this.agents.values()) {
      if (info.status !== 'dispatched') continue;
      if (info.agentName && info.agentName.toLowerCase() === fromLower) return info;
      const label = (info.label || info.toolName).toLowerCase();
      if (label === fromLower || label.includes(fromLower) || fromLower.includes(label)) return info;
    }
    return null;
  }

  handleTaskStarted(toolUseId: string, description: string, _taskType?: string): void {
    const info = this.agents.get(toolUseId);
    if (!info) return;

    if (description && labelFieldPriority('description') < labelFieldPriority(info.labelField)) {
      info.label = description.slice(0, 80);
      info.labelField = 'description';
    }

    info.status = 'dispatched';
    if (!info.dispatchedAt) info.dispatchedAt = Date.now();
    if (!this.inTurn) this.updateStandaloneMessage();
  }

  handleTaskProgress(toolUseId: string, description: string, lastToolName?: string): void {
    const info = this.agents.get(toolUseId);
    if (!info || info.status === 'completed') return;
    const line = formatProgressLine(description, lastToolName);
    if (line) {
      info.progressLines.push(line);
      if (info.progressLines.length > MAX_PROGRESS_LINES) info.progressLines.shift();
    }
    if (!this.inTurn) this.updateStandaloneMessage();
  }

  handleTaskCompleted(toolUseId: string): void {
    const info = this.agents.get(toolUseId);
    if (!info || info.status === 'completed') return;

    info.status = 'completed';
    if (!this.inTurn) this.updateStandaloneMessage();

    const allDone = ![...this.agents.values()].some(a => a.status === 'dispatched');
    if (allDone && this.onAllReported) {
      this.onAllReported();
      this.stopMailboxWatch();
    }
  }

  /** Build the standalone status bubble HTML. */
  private buildStandaloneHtml(): string {
    const entries: string[] = [];
    for (const info of this.agents.values()) {
      const label = info.label || info.agentName || info.toolName;
      const elapsed = formatElapsed(Date.now() - info.startTime);
      let statusLine: string;
      if (info.status === 'completed') {
        statusLine = `🤖 ${escapeHtml(label)} — ✅ Done (${elapsed})`;
      } else {
        statusLine = `🤖 ${escapeHtml(label)} — Working (${elapsed})…`;
      }
      const progressBlock = info.progressLines.length > 0
        ? '\n' + info.progressLines.join('\n')
        : '';
      entries.push(statusLine + progressBlock);
    }
    return `<blockquote>${entries.join('\n\n')}</blockquote>`;
  }

  /** Edit the standalone status bubble with current state. */
  private updateStandaloneMessage(): void {
    if (!this.standaloneMsgId) return;
    const msgId = this.standaloneMsgId;
    const html = this.buildStandaloneHtml();
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.sender.editMessage(this.chatId, msgId, html, 'HTML');
      } catch { /* non-critical */ }
    }).catch(() => {});
  }

  getAgentByToolUseId(toolUseId: string): SubAgentInfo | undefined {
    return this.agents.get(toolUseId);
  }

  reset(): void {
    this.stopMailboxWatch();
    this.agents.clear();
    this.blockToAgent.clear();
    this.standaloneMsgId = null;
    this.sendQueue = Promise.resolve();
    this.teamName = null;
    this.mailboxPath = null;
    this.lastMailboxCount = 0;
    this.onAllReported = null;
    this.inTurn = true;
  }
}

// ── Utility: split a completed text into TG-sized chunks ──

export function splitText(text: string, maxLength: number = 3500): string[] {
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
