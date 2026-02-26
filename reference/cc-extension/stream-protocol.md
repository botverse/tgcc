# CC CLI Stream Protocol - Reverse Engineered Reference

## Output Event Types (stdout JSON lines)
CC emits these event types on stdout when using --output-format stream-json:

### type: "assistant"  
Assistant message with content blocks (text, tool_use, thinking)

### type: "user"
User message, including tool_result content blocks.
tool_result can contain:
- { type: "text", text: "..." }
- { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
- { type: "document", source: { type: "base64", media_type: "application/pdf", data: "..." } }

### type: "system"
System events. Has subtypes:
- subtype: "init" — session initialized
- subtype: "compact_boundary" — context compacted
- subtype: "file_snapshot" — file snapshot for recovery
- subtype: "task_started" — background task started
  Fields: task_id, tool_use_id, description, task_type
- subtype: "task_progress" — background task progress update
  Fields: task_id, tool_use_id, description, usage, last_tool_name
- subtype: "task_completed" — background task finished (via TaskCompleted event)

### type: "result"
Final result with cost_usd, duration_ms, etc.

## Streaming Content Blocks
Within assistant messages:
- content_block_start: { type: "text"|"thinking"|"tool_use"|"image", index, content_block }
- content_block_delta: { type: "text_delta"|"thinking_delta"|"input_json_delta"|"image_delta" }
- content_block_stop: { index }
- message_start, message_delta, message_stop

## Task/Agent Tool Input Schema (Kn4)
The Task tool input has these fields:
- description: string — "A short (3-5 word) description of the task"
- prompt: string — "The task for the agent to perform"  
- subagent_type: string — "The type of specialized agent to use"
- model: "sonnet"|"opus"|"haiku" (optional)
- resume: string (optional) — agent ID to resume
- run_in_background: boolean (optional)
- max_turns: number (optional)
- name: string (optional) — "Name for the spawned agent"
- team_name: string (optional)
- mode: string (optional) — permission mode
- isolation: "worktree" (optional)

## Task Tool Result
On completion, the tool_result contains:
- status: "completed" | "async_launched"
- For completed: content (text blocks), totalToolUseCount, totalDurationMs, totalTokens, usage
- For async: agentId, description, prompt, outputFile

## How Agent Labels Work
1. tool_use block has name="Task" (always "Task" — not the agent name!)
2. The input JSON contains: description, subagent_type, name
3. The "description" is the short label (3-5 words)
4. The "subagent_type" is the agent kind (e.g. "general-purpose")
5. The "name" is the optional agent name for teammates

## Sub-agent Result Delivery
- Synchronous: tool_result content block in the stream (text blocks)
- Async (run_in_background=true): writes to ~/.claude/agent-output/<id>.output
  - The output file path is returned in tool_result.outputFile
  - System events type:"system" subtype:"task_started"/"task_progress" track status
