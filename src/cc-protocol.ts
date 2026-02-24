import { v4 as uuidv4 } from 'uuid';

// ── Input message construction (TG → CC stdin) ──

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ImageContent {
  type: 'image';
  source: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
}

export type ContentBlock = TextContent | ImageContent;

export interface UserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  uuid: string;
}

export function createTextMessage(text: string): UserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    uuid: uuidv4(),
  };
}

export function createImageMessage(
  text: string,
  imageBase64: string,
  mediaType: ImageContent['source']['media_type'] = 'image/jpeg'
): UserMessage {
  const content: ContentBlock[] = [
    { type: 'text', text },
    { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
  ];
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: uuidv4(),
  };
}

export function createDocumentMessage(text: string, filePath: string, fileName: string): UserMessage {
  const content = `${text}\n\nUser sent a document: ${filePath} (${fileName}). Read and process it.`;
  return createTextMessage(content);
}

export function serializeMessage(msg: UserMessage): string {
  return JSON.stringify(msg);
}

// ── Control request/response (SDK initialize handshake + permissions) ──

export interface ControlRequestInitialize {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: 'initialize';
  };
}

export interface PermissionRequest {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: 'can_use_tool';
    tool_name: string;
    input: Record<string, unknown>;
    tool_use_id: string;
    agent_id?: string;
    permission_suggestions?: unknown[];
    blocked_path?: string;
    decision_reason?: string;
  };
}

export type ControlRequest = ControlRequestInitialize | PermissionRequest;

export interface ControlResponse {
  type: 'control_response';
  request_id?: string;
  response: {
    subtype: 'success' | 'error';
    request_id?: string;
    response?: {
      behavior: 'allow' | 'deny';
      updatedInput?: Record<string, unknown>;
      message?: string;
    };
    error?: string;
    [key: string]: unknown;
  };
}

export function createInitializeRequest(): ControlRequestInitialize {
  return {
    type: 'control_request',
    request_id: uuidv4(),
    request: { subtype: 'initialize' },
  };
}

export function createPermissionResponse(
  requestId: string,
  allowed: boolean,
  updatedInput?: Record<string, unknown>,
): ControlResponse {
  if (allowed) {
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: {
          behavior: 'allow',
          updatedInput,
        },
      },
    };
  }
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: {
        behavior: 'deny',
        message: 'Denied by user via Telegram',
      },
    },
  };
}

// ── Output event types (CC stdout → parse) ──

export interface InitEvent {
  type: 'system';
  subtype: 'init';
  cwd: string;
  session_id: string;
  tools: string[];
  model: string;
  uuid: string;
}

export interface AssistantTextBlock {
  type: 'text';
  text: string;
}

export interface AssistantToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface AssistantThinkingBlock {
  type: 'thinking';
  thinking: string;
}

export type AssistantContentBlock = AssistantTextBlock | AssistantToolUseBlock | AssistantThinkingBlock;

export interface AssistantMessage {
  type: 'assistant';
  message: {
    model: string;
    id: string;
    role: 'assistant';
    content: AssistantContentBlock[];
    stop_reason: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  session_id?: string;
  uuid?: string;
}

export interface ToolResultEvent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface ResultEvent {
  type: 'result';
  subtype: 'success' | 'error' | 'error_max_turns' | 'error_input';
  is_error: boolean;
  duration_ms?: number;
  duration_api_ms?: number;
  num_turns?: number;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    web_search_requests?: number;
  };
  uuid?: string;
}

// ── Stream events (--include-partial-messages) ──

export interface StreamMessageStart {
  type: 'message_start';
  message: {
    model: string;
    id: string;
    role: 'assistant';
    content: unknown[];
    stop_reason: null;
    usage: Record<string, number>;
  };
}

export interface StreamContentBlockStartText {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'text'; text: string };
}

export interface StreamContentBlockStartThinking {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'thinking'; thinking: string };
}

export interface StreamContentBlockStartToolUse {
  type: 'content_block_start';
  index: number;
  content_block: { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
}

export type StreamContentBlockStart =
  | StreamContentBlockStartText
  | StreamContentBlockStartThinking
  | StreamContentBlockStartToolUse;

export interface StreamTextDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'text_delta'; text: string };
}

export interface StreamThinkingDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'thinking_delta'; thinking: string };
}

export interface StreamInputJsonDelta {
  type: 'content_block_delta';
  index: number;
  delta: { type: 'input_json_delta'; partial_json: string };
}

export type StreamContentBlockDelta = StreamTextDelta | StreamThinkingDelta | StreamInputJsonDelta;

export interface StreamContentBlockStop {
  type: 'content_block_stop';
  index: number;
}

export interface StreamMessageStop {
  type: 'message_stop';
}

export type StreamInnerEvent =
  | StreamMessageStart
  | StreamContentBlockStart
  | StreamContentBlockDelta
  | StreamContentBlockStop
  | StreamMessageStop;

export interface StreamEvent {
  type: 'stream_event';
  event: StreamInnerEvent;
}

// ── API error events ──

export interface ApiErrorEvent {
  type: 'system';
  subtype: 'api_error';
  level: 'error';
  error: {
    message?: string;
    status?: number;
    [key: string]: unknown;
  };
  retryInMs?: number;
  retryAttempt?: number;
  maxRetries?: number;
  timestamp?: string;
  uuid?: string;
}

// ── Union of all CC output events ──

/** User output message — wraps tool_result content blocks (sub-agent results). */
export interface UserOutputMessage {
  type: 'user';
  message: {
    role: 'user';
    content: Array<{
      type: string;
      tool_use_id?: string;
      content?: string | Array<{ type: string; text?: string }>;
      is_error?: boolean;
    }>;
  };
}

export type CCOutputEvent =
  | InitEvent
  | AssistantMessage
  | UserOutputMessage
  | ToolResultEvent
  | ResultEvent
  | StreamEvent
  | ControlResponse
  | ApiErrorEvent
  | PermissionRequest;

// ── Parser ──

export function parseCCOutputLine(line: string): CCOutputEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed.type !== 'string') return null;

    switch (parsed.type) {
      case 'system':
      case 'assistant':
      case 'user':
      case 'tool_result':
      case 'result':
      case 'stream_event':
      case 'control_response':
      case 'control_request':
        return parsed as CCOutputEvent;
      default:
        // Log unknown event types for discovery
        if (typeof parsed.type === 'string') {
          console.log(`[CC-RAW] Unknown event type: ${parsed.type}`, JSON.stringify(parsed).slice(0, 200));
        }
        return null;
    }
  } catch {
    return null;
  }
}

// ── Helpers for extracting text from assistant messages ──

export function extractAssistantText(msg: AssistantMessage): string {
  return msg.message.content
    .filter((b): b is AssistantTextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');
}

export function extractToolUses(msg: AssistantMessage): AssistantToolUseBlock[] {
  return msg.message.content.filter((b): b is AssistantToolUseBlock => b.type === 'tool_use');
}

export function isStreamTextDelta(event: StreamInnerEvent): event is StreamTextDelta {
  return event.type === 'content_block_delta' && (event as StreamTextDelta).delta?.type === 'text_delta';
}

export function isStreamThinkingDelta(event: StreamInnerEvent): event is StreamThinkingDelta {
  return event.type === 'content_block_delta' && (event as StreamThinkingDelta).delta?.type === 'thinking_delta';
}

export function getStreamBlockType(event: StreamInnerEvent): string | null {
  if (event.type === 'content_block_start') {
    return (event as StreamContentBlockStart).content_block.type;
  }
  return null;
}
