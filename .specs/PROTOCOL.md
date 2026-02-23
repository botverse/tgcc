# CC Stream-JSON Protocol Reference

## Confirmed via Testing (2026-02-23)

### Input Format

CC CLI with `--input-format stream-json` accepts NDJSON on stdin.

#### Text Message

```json
{"type":"user","message":{"role":"user","content":"hello world"},"uuid":"<uuidv4>"}
```

#### Image Message (CONFIRMED WORKING)

Content blocks follow the Anthropic API format:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {"type": "text", "text": "What color is this?"},
      {
        "type": "image",
        "source": {
          "type": "base64",
          "media_type": "image/png",
          "data": "<base64-encoded-image>"
        }
      }
    ]
  },
  "uuid": "<uuidv4>"
}
```

Tested with a 1px yellow PNG → CC responded "Light yellow." ✅

Supported media types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`

### Output Format

CC CLI with `--output-format stream-json --verbose` emits NDJSON on stdout.

#### Init Event

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "/path/to/dir",
  "session_id": "<uuid>",
  "tools": ["Bash", "Read", "Write", "Edit", ...],
  "model": "claude-opus-4-6",
  "uuid": "<uuid>"
}
```

#### Assistant Message

```json
{
  "type": "assistant",
  "message": {
    "model": "claude-opus-4-6",
    "id": "msg_...",
    "role": "assistant",
    "content": [
      {"type": "text", "text": "Here's my response..."}
    ],
    "stop_reason": null,
    "usage": {
      "input_tokens": 3,
      "output_tokens": 42,
      "cache_read_input_tokens": 21989,
      "cache_creation_input_tokens": 1478
    }
  },
  "session_id": "<uuid>",
  "uuid": "<uuid>"
}
```

Note: `stop_reason: null` during streaming, will be set on final message.

#### Tool Use (CC using a tool)

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "tool_use",
        "id": "toolu_...",
        "name": "Write",
        "input": {
          "file_path": "/tmp/output.txt",
          "content": "file contents here"
        }
      }
    ]
  }
}
```

**Key for file output detection**: When CC uses the `Write` tool with a path in our output directory, we know to send that file to TG.

#### Tool Result

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_...",
  "content": "..."
}
```

#### Result Event (Turn Complete)

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 2511,
  "duration_api_ms": 2398,
  "num_turns": 1,
  "result": "Here's my response...",
  "session_id": "<uuid>",
  "total_cost_usd": 0.020422,
  "usage": {
    "input_tokens": 3,
    "output_tokens": 7,
    "cache_read_input_tokens": 21989,
    "cache_creation_input_tokens": 1478,
    "web_search_requests": 0
  },
  "uuid": "<uuid>"
}
```

#### Error Result

```json
{
  "type": "result",
  "subtype": "error_max_turns",
  "is_error": true,
  "result": "...",
  "session_id": "<uuid>"
}
```

Other error subtypes: `error`, `error_max_turns`, `error_input`

### CC CLI Flags Reference

```bash
claude -p \
  --input-format stream-json \     # Accept NDJSON on stdin
  --output-format stream-json \    # Emit NDJSON on stdout  
  --verbose \                      # Required for stream-json output with -p
  --no-session-persistence=false \ # Keep sessions (default, but explicit)
  --continue \                     # Resume most recent session in CWD
  --resume <session-id> \          # Resume specific session
  --session-id <uuid> \            # Use specific session ID
  --model <model> \                # Override model
  --max-turns 50 \                 # Limit turns per interaction
  --add-dir <path> \               # Add directory to tool access
  --max-budget-usd <amount> \      # Cost limit
  --dangerously-skip-permissions   # For sandboxed environments
```

### File Handling

CC has a `--file` flag for downloading files at startup:
```bash
--file file_abc:doc.txt file_def:img.png
```

But for our use case, we save files to disk and reference them in the message text instead — simpler and works with the stream-json input format.

### Streaming Events (CONFIRMED WORKING)

With `--include-partial-messages`, CC emits `stream_event` NDJSON lines containing raw Anthropic SSE events:

#### Message Start
```json
{"type":"stream_event","event":{"type":"message_start","message":{"model":"claude-opus-4-6","id":"msg_...","role":"assistant","content":[],"stop_reason":null,"usage":{...}}}}
```

#### Content Block Start (text or thinking)
```json
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}}
```
For thinking blocks: `"content_block":{"type":"thinking","thinking":""}}`

#### Content Block Delta (incremental text)
```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"chunk of text"}}}
```
For thinking: `"delta":{"type":"thinking_delta","thinking":"..."}`

#### Content Block Stop
```json
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
```

#### Message Stop
```json
{"type":"stream_event","event":{"type":"message_stop"}}
```

#### Streaming Strategy for TG

1. On `content_block_start` with `type: "thinking"` → send "🤔 *Thinking...*" to TG
2. Ignore `thinking_delta` content (don't leak thinking to user)
3. On `content_block_start` with `type: "text"` → start accumulating text
4. On each `text_delta` → append to buffer, throttled edit TG message (max 1 edit/sec)
5. On `message_stop` → final edit with complete text
6. During tool_use blocks → optionally show "🔧 *Using [tool_name]...*"

### Session Persistence

CC stores sessions at `~/.claude/projects/<project-hash>/sessions/`.
Sessions can be resumed with `--continue` (most recent) or `--resume <id>`.
The `session_id` is returned in the `system.init` event.
