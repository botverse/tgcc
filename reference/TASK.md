# TGCC Sub-Agent Display & System Events Fix

## Reference Material
- `reference/cc-extension/stream-protocol.md` — CC CLI stream protocol (reverse engineered)
- `reference/cc-extension/task-tool-result-mapping.md` — how Task tool results are mapped
- CC CLI source (minified): `/home/linuxbrew/.linuxbrew/lib/node_modules/@anthropic-ai/claude-code/cli.js`

## Problems to Fix

### 1. Sub-agent labels all show same name ("general-purpose")
**File:** `src/streaming.ts` — SubAgentTracker

The label extraction in `extractAgentLabel()` gets the label from the streaming JSON input.
But it falls back to `info.toolName` which is always "Task" — not useful.

The CC Task tool input has:
- `description` — "A short (3-5 word) description" ← **best label**
- `subagent_type` — agent type like "general-purpose"  
- `name` — optional agent name for teammates

**Fix:** Priority should be: `name` > `description` > `subagent_type` > toolName.
The `extractAgentLabel` needs to check the streaming JSON for `description` field.

### 2. System events not handled
**File:** `src/cc-process.ts`

CC emits `type: "system"` events with subtypes:
- `task_started` — has task_id, description, task_type
- `task_progress` — has task_id, description, usage, last_tool_name

These are NOT currently handled in cc-process.ts. They should be emitted so the bridge/streaming can use them for better sub-agent status display.

### 3. Async task results not relayed  
When CC spawns agents with `run_in_background: true`, results go to output files, not tool_result blocks.
The `task_progress` and `task_started` system events are the only way to track these.

TGCC should:
- Listen for `system` events with `subtype: "task_started"` and `"task_progress"`
- Use them to update sub-agent status display
- When a task completes, relay the result

### 4. Injected messages should be marked as system
**File:** `src/bridge.ts`

When TGCC injects "All background agents reported" messages, they go as user role.
CC's stream-json protocol accepts `type: "system"` messages — check if we can inject as system instead of user.

## Architecture
- `src/cc-process.ts` — spawns CC CLI, parses stdout JSON, emits events
- `src/cc-protocol.ts` — TypeScript types for the CC stream protocol  
- `src/streaming.ts` — StreamAccumulator (text/images) + SubAgentTracker
- `src/bridge.ts` — orchestrates CC process, TG bot, and message routing
- `src/telegram-html-remark.ts` — markdown → Telegram HTML conversion

## Testing
Run `pnpm dev` to start TGCC locally. Use the tgcc Telegram bot to test.
Run `npx tsc --noEmit` to type-check.
