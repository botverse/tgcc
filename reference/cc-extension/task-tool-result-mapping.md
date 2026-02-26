# Task Tool Result Mapping (from CC CLI source)

When a Task (subagent) completes synchronously, the result is mapped to tool_result_block:

```
For status === "teammate_spawned":
  content: [{type: "text", text: "Spawned successfully.\nagent_id: ...\nname: ...\nteam_name: ..."}]

For status === "async_launched":  
  content: [{type: "text", text: "Async agent launched successfully.\nagentId: ...\noutput_file: ..."}]

For status === "completed":
  content: the agent's actual response content blocks (text[])
```

## System Events for Background Tasks

When a task starts:
```json
{
  "type": "system",
  "subtype": "task_started", 
  "task_id": "...",
  "tool_use_id": "...",
  "description": "short task description",
  "task_type": "subagent_type value"
}
```

When progress updates:
```json
{
  "type": "system",
  "subtype": "task_progress",
  "task_id": "...",
  "tool_use_id": "...",  
  "description": "current activity",
  "usage": { "total_tokens": N, "tool_uses": N, "duration_ms": N },
  "last_tool_name": "Bash" // etc
}
```
