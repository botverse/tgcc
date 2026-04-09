# CC Protocol Reference

> What Claude Code sends to TGCC via `--output-format stream-json`, and what TGCC sends back via stdin. Derived from CC source audit (2026-04-04).

## 1. Input: TGCC → CC (stdin)

### User Messages

```typescript
{
  type: 'user',
  message: { role: 'user', content: string | ContentBlock[] },
  uuid: string
}
```

Content blocks: `TextContent` (`type: 'text'`), `ImageContent` (`type: 'image'`, base64).

### Tool Results

```typescript
{
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: string, content: string }]
  },
  uuid: string
}
```

### Control Responses (permissions)

```typescript
{
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: string,
    response: { behavior: 'allow' | 'deny', updatedInput?: {}, message?: string }
  }
}
```

## 2. Output: CC → TGCC (stdout)

### System Events

| Subtype | When | Key fields |
|---------|------|------------|
| `init` | CC process starts | `session_id`, `tools[]`, `model`, `cwd` |
| `api_error` | API call fails | `error.message`, `error.status`, `retryInMs` |
| `api_retry` | API retry attempt | `attempt`, `max_retries`, `retry_delay_ms` |
| `task_started` | Sub-agent begins | `task_id`, `tool_use_id`, `description` |
| `task_progress` | Sub-agent tool call | `task_id`, `last_tool_name`, `usage.tool_uses` |
| `task_completed` | Sub-agent finishes | `task_id`, `tool_use_id` |
| `compact_boundary` | Context compaction | `compact_metadata.trigger`, `pre_tokens` |

### Assistant Messages (non-streaming)

```typescript
{
  type: 'assistant',
  message: {
    model: string,
    id: string,
    role: 'assistant',
    content: AssistantContentBlock[],
    stop_reason: string | null,
    usage?: { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens?, web_search_requests? }
  }
}
```

### Content Block Types

| Type | Description | Key field |
|------|-------------|-----------|
| `text` | Response text | `text: string` |
| `thinking` | Extended thinking | `thinking: string` |
| `redacted_thinking` | Redacted thinking (safety) | `redacted_thinking: string` |
| `tool_use` | Tool invocation | `id`, `name`, `input` |
| `signature` | Response signature | `signature: string` |

`redacted_thinking` and `signature` blocks are pass-through — TGCC doesn't render them but handles them gracefully in streaming.

### Tool Results

```typescript
{
  type: 'tool_result',
  tool_use_id: string,
  content: string,
  is_error?: boolean,
  tool_use_result?: {    // Rich metadata (sub-agent spawns, etc.)
    status?: string,     // e.g. 'teammate_spawned'
    name?: string,
    agent_id?: string,
    agent_type?: string,
    color?: string,
    team_name?: string,
    prompt?: string,
    teammate_id?: string,
    [key: string]: unknown
  }
}
```

### Result Event (turn complete)

```typescript
{
  type: 'result',
  subtype: 'success' | 'error' | 'error_max_turns' | 'error_input' | 'error_during_execution',
  is_error: boolean,
  duration_ms?: number,
  duration_api_ms?: number,
  num_turns?: number,
  result?: string,
  session_id?: string,
  total_cost_usd?: number,
  stop_reason?: string | null,
  errors?: string[],              // Error details for error_during_execution
  permission_denials?: unknown[],
  model_usage?: Record<string, unknown>,
  usage?: { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens?, web_search_requests? }
}
```

The `error_during_execution` subtype includes an `errors[]` array with detailed error messages — useful for surfacing what went wrong to TG.

### Control Requests (permissions)

```typescript
{
  type: 'control_request',
  request_id: string,
  request: {
    subtype: 'can_use_tool' | 'initialize',
    tool_name?: string,
    input?: Record<string, unknown>,
    tool_use_id?: string,
    agent_id?: string,
    permission_suggestions?: unknown[],
    blocked_path?: string,
    decision_reason?: string
  }
}
```

## 3. Stream Events

When using `--output-format stream-json`, CC wraps streaming events in `{ type: 'stream_event', event: StreamInnerEvent }`.

### Stream Event Types

| Event | When | Contains |
|-------|------|----------|
| `message_start` | New assistant turn | `message.model`, `message.usage` |
| `content_block_start` | New content block | `index`, `content_block.type` (+type-specific fields) |
| `content_block_delta` | Incremental content | `index`, `delta` (+type-specific fields) |
| `content_block_stop` | Block complete | `index` |
| `message_stop` | Turn complete | (empty) |

### Delta Types

| Delta type | Content block | Key field |
|------------|--------------|-----------|
| `text_delta` | `text` | `text: string` |
| `thinking_delta` | `thinking` | `thinking: string` |
| `input_json_delta` | `tool_use` | `partial_json: string` |
| `redacted_thinking_delta` | `redacted_thinking` | `redacted_thinking: string` |
| `signature_delta` | `signature` | `signature: string` |

## 4. Session Discovery

CC stores sessions at `~/.claude/projects/<slug>/<sessionId>.jsonl`.

### Project Slug Computation

Matches CC's `sanitizePath` logic:

```typescript
function computeProjectSlug(repoPath: string): string {
  const base = repoPath.replace(/[/.]/g, '-');
  if (base.length <= 50) return base;
  const hash = sha256(repoPath).slice(0, 8);
  return base.slice(0, 41) + '-' + hash;
}
```

### Session Filtering

TGCC filters sessions during discovery:
- **UUID validation** — only valid UUID-formatted session IDs (CC rejects others)
- **Sidechain filtering** — sessions with `isSidechain: true` in the first JSONL line are sub-agent forks, excluded from user-facing session lists
- **Agent prefix filtering** — files starting with `agent-` are sub-agent transcripts, skipped
- **30-day expiry** — sessions older than 30 days are excluded
- **Empty session filtering** — sessions with no real user messages (title = "untitled") are excluded

### Context Window Calculation

Model-aware context window for percentage calculation:

| Model family | Context window |
|-------------|----------------|
| Opus | 200,000 tokens |
| Sonnet | 200,000 tokens |
| Haiku | 200,000 tokens |
| Default | 200,000 tokens |

Context % = `(input_tokens + cache_read + cache_creation) / context_window * 100`

### Session End State

Determined by reading the last few KB of the JSONL:
- `completed` — last assistant message has `stop_reason: 'end_turn'`
- `interrupted` — last message is user (CC never responded) or assistant without `end_turn`
- `unknown` — can't determine

## 5. Sub-Agent Detection

CC spawns sub-agents via these tool names (detected by TGCC in `streaming.ts` and `high-signal.ts`):

| Tool name | Description |
|-----------|-------------|
| `Agent` | General-purpose sub-agent |
| `Task` | Task-specific sub-agent |
| `SendMessage` | Inter-agent messaging |
| `TeamCreate` | Team creation |

The `tool_use_result` for these tools may contain `status: 'teammate_spawned'` with metadata (`agent_id`, `agent_type`, `team_name`).

Sub-agent progress is tracked via `task_started`, `task_progress`, and `task_completed` system events, keyed by `tool_use_id`.

## 6. Key Differences from Raw Anthropic API

CC's stream-json output differs from the raw Anthropic Messages API:

1. **Wrapped in envelopes** — stream events are `{ type: 'stream_event', event: ... }`, not raw SSE
2. **Additional system events** — `init`, `api_error`, `api_retry`, `task_*`, `compact_boundary`
3. **Tool results as separate events** — `{ type: 'tool_result', ... }` not part of `user` messages
4. **Result event** — `{ type: 'result', ... }` with cost, duration, turn count
5. **Control protocol** — `control_request`/`control_response` for permissions (initialize + can_use_tool)
6. **Session management** — `session_id` on init/result events, JSONL persistence

## 7. Implementation Files

| File | What it handles |
|------|----------------|
| `src/cc-protocol.ts` | All TypeScript types for CC input/output events |
| `src/session.ts` | Session discovery, slug computation, JSONL parsing |
| `src/streaming.ts` | Stream event → segment → TG message rendering |
| `src/cc-process.ts` | CC process spawning, stdin/stdout management |
