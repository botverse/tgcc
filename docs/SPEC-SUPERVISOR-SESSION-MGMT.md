# SPEC: Supervisor Session Management Commands

**Status:** Draft  
**Date:** 2026-03-03  
**Author:** BossBot (Tech Lead)

## Problem

The supervisor protocol (used by the OpenClaw plugin) can only spawn processes and send messages. All session management — new sessions, resume, model/repo switching, cancel, compact — is only available via Telegram slash commands. This means the Tech Lead agent (me) can't:

- Start a fresh session on an agent without losing the ability to resume the old one
- Resume a specific session by ID
- Switch an agent's model or repo programmatically
- Cancel a running turn without killing the entire process
- Trigger context compaction when an agent hits pressure
- List available sessions for an agent

## Design Principle

Each new supervisor command maps 1:1 to an existing TG slash command handler. No new logic — just expose what already works via the supervisor socket.

## New Supervisor Commands

### `session_new`
**Maps to:** `/new` handler  
**Params:** `{ agentId: string }`  
**Effect:** Kill current CC process, clear pending session. Next `send_message` starts fresh.  
**Returns:** `{ cleared: true }`

### `session_continue`
**Maps to:** `/continue` handler  
**Params:** `{ agentId: string }`  
**Effect:** Kill current CC process, preserve session ID for auto-resume on next message.  
**Returns:** `{ sessionId: string | null }`

### `session_resume`
**Maps to:** `/resume` handler  
**Params:** `{ agentId: string, sessionId: string }`  
**Effect:** Kill current CC process, set pending session ID. Next `send_message` resumes it.  
**Returns:** `{ pendingSessionId: string }`

### `session_list`
**Maps to:** `/sessions` handler  
**Params:** `{ agentId: string, limit?: number }`  
**Effect:** List recent CC sessions for the agent's repo.  
**Returns:**
```typescript
{
  sessions: Array<{
    id: string;
    title: string;
    age: string;
    lineCount: number;
    contextPct: number | null;
    model: string | null;
    isCurrent: boolean;
  }>;
}
```

### `set_model`
**Maps to:** `/model` handler  
**Params:** `{ agentId: string, model: string }`  
**Effect:** Change agent model, kill current process. Takes effect on next message.  
**Returns:** `{ model: string, previousModel: string }`

### `set_repo`
**Maps to:** `/repo <path>` handler  
**Params:** `{ agentId: string, repo: string }`  
**Effect:** Change agent repo (name or path), kill current process, clear session.  
**Returns:** `{ repo: string, previousRepo: string }`

### `cancel_turn`
**Maps to:** `/cancel` handler  
**Params:** `{ agentId: string }`  
**Effect:** Cancel current CC turn (sends interrupt signal). Process stays alive.  
**Returns:** `{ cancelled: boolean }`

### `compact`
**Maps to:** `/compact` handler  
**Params:** `{ agentId: string, instructions?: string }`  
**Effect:** Send `/compact [instructions]` to the running CC process.  
**Returns:** `{ sent: boolean }`  
**Errors:** If no active CC process.

### `set_permissions`
**Maps to:** `/permissions` handler  
**Params:** `{ agentId: string, mode: 'dangerously-skip' | 'acceptEdits' | 'default' | 'plan' }`  
**Effect:** Set permission mode, kill current process. Takes effect on next message.  
**Returns:** `{ mode: string, previousMode: string }`

## Plugin Tool Updates

### Extend `tgcc_send`

Add optional params:
- `newSession: boolean` — call `session_new` before sending (fresh start)
- `sessionId: string` — call `session_resume` before sending (resume specific session)
- `model: string` — call `set_model` before sending (switch model for this task)

This keeps the common workflow as a single tool call:
```
tgcc_send(agentId="tgcc", text="fix the bug", newSession=true, model="opus")
```

### New tool: `tgcc_session`

For session management that doesn't involve sending a message:
```
tgcc_session(agentId, action="list")              → list sessions
tgcc_session(agentId, action="cancel")             → cancel current turn
tgcc_session(agentId, action="compact", instructions="focus on streaming.ts")
tgcc_session(agentId, action="set_model", model="opus")
tgcc_session(agentId, action="set_repo", repo="tgcc")
tgcc_session(agentId, action="set_permissions", mode="acceptEdits")
```

## Implementation

### Bridge changes (`bridge.ts`)

Add cases to `handleSupervisorCommand()` switch. Each case extracts the agent instance and delegates to the same logic used by the TG slash command handlers. Refactor slash command handlers to call shared helper methods if they aren't already factored out.

Pattern:
```typescript
case 'session_new': {
  const agentId = params.agentId as string;
  if (!agentId) throw new Error('Missing agentId');
  const agent = this.agents.get(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}`);
  
  this.killAgentProcess(agentId);
  agent.pendingSessionId = null;
  return { cleared: true };
}
```

### Plugin changes

1. Add `tgcc_session` tool definition and handler
2. Extend `tgcc_send` with optional `newSession`, `sessionId`, `model` params
3. Update SKILL.md with new capabilities

## Migration

No breaking changes. All existing tools continue to work. New commands are additive.

## Testing

1. `tgcc_session(agentId="tgcc", action="list")` — verify session list returns
2. `tgcc_send(agentId="tgcc", text="hello", newSession=true)` — verify fresh session
3. `tgcc_session(agentId="tgcc", action="cancel")` — verify turn cancelled without process death
4. `tgcc_session(agentId="tgcc", action="compact")` — verify compaction triggers
5. `tgcc_send(agentId="tgcc", text="task", model="haiku")` — verify model switch + task in one call
