// ── @fonz/tgcc — Library exports ──
//
// This file is the public API surface for library consumers.
// The standalone service entry point is in ./service.ts (invoked via CLI).

// CC process lifecycle
export {
  CCProcess,
  type CCProcessOptions,
  type CCUserConfig,
  type ProcessState,
  type CCActivityState,
  hasActiveChildren,
  generateMcpConfig,
} from './cc-process.js';

// Protocol types and parsers
export {
  parseCCOutputLine,
  createInitializeRequest,
  createPermissionResponse,
  createTextMessage,
  createImageMessage,
  createDocumentMessage,
  serializeMessage,
  extractAssistantText,
  extractToolUses,
  isStreamTextDelta,
  isStreamThinkingDelta,
  getStreamBlockType,
  // Input types
  type TextContent,
  type ImageContent,
  type ContentBlock,
  type UserMessage,
  // Control types
  type ControlRequestInitialize,
  type PermissionRequest,
  type ControlRequest,
  type ControlResponse,
  // Output event types
  type InitEvent,
  type AssistantTextBlock,
  type AssistantToolUseBlock,
  type AssistantThinkingBlock,
  type AssistantContentBlock,
  type AssistantMessage,
  type ToolResultEvent,
  type ResultEvent,
  type ApiErrorEvent,
  type CCOutputEvent,
  // Stream types
  type StreamMessageStart,
  type StreamContentBlockStart,
  type StreamContentBlockStartText,
  type StreamContentBlockStartThinking,
  type StreamContentBlockStartToolUse,
  type StreamTextDelta,
  type StreamThinkingDelta,
  type StreamInputJsonDelta,
  type StreamContentBlockDelta,
  type StreamContentBlockStop,
  type StreamMessageStop,
  type StreamInnerEvent,
  type StreamEvent,
} from './cc-protocol.js';

// Session store
export {
  SessionStore,
  getSessionJsonlPath,
  findMissedSessions,
  computeProjectSlug,
  summarizeJsonlDelta,
  formatCatchupMessage,
  type SessionInfo,
  type UserState,
  type AgentState,
  type StateStore,
  type JsonlTracking,
} from './session.js';

// Streaming utilities
export {
  StreamAccumulator,
  SubAgentTracker,
  markdownToHtml,
  makeHtmlSafe,
  escapeHtml,
  formatUsageFooter,
  splitText,
  isSubAgentTool,
  type TelegramSender,
  type TurnUsage,
  type StreamAccumulatorOptions,
  type SubAgentInfo,
  type SubAgentSender,
  type SubAgentTrackerOptions,
} from './streaming.js';
