# Multi-Client Session Attachment

## Problem

When two TGCC agents (e.g. `kyobot` and `tgcc`) both `/continue` the same CC session on the same repo, only the agent that spawned the CC process receives output. The other agent's messages go to a separate CC process (or fail), because processes are keyed by `userId` within each agent — there's no cross-agent process sharing.

## Current Architecture

```
Agent "kyobot" (agentId)
  └─ processes: Map<userId, CCProcess>
       └─ userId "123" → CCProcess (pid 4567, session abc123)

Agent "tgcc" (agentId) 
  └─ processes: Map<userId, CCProcess>
       └─ userId "123" → CCProcess (pid 8901, session abc123)  ← DUPLICATE!
```

Two CC processes competing for the same session JSONL. Only one gets coherent output. The staleness detector may kill the other.

## Solution: Shared Process Registry

Replace per-agent process maps with a **global process registry** keyed by `repo + sessionId`. Multiple agents (and the same agent across users) can attach to one CC process as output subscribers.

### New Architecture

```
ProcessRegistry (global, singleton)
  └─ key: "${repo}:${sessionId}" → SharedProcess
       ├─ ccProcess: CCProcess (single instance)
       ├─ owner: { agentId, userId, chatId }  (who spawned it)
       └─ subscribers: Set<{ agentId, userId, chatId }>  (who receives output)
```

### Key Changes

#### 1. `ProcessRegistry` class (new file: `src/process-registry.ts`)

```typescript
interface ProcessEntry {
  ccProcess: CCProcess;
  repo: string;
  sessionId: string;
  owner: ClientRef;
  subscribers: Set<ClientRef>;  // includes owner
}

interface ClientRef {
  agentId: string;
  userId: string;
  chatId: number;
}

class ProcessRegistry {
  private entries: Map<string, ProcessEntry> = new Map();  // "repo:sessionId" → entry

  /** Get existing process for a repo+session, or null */
  get(repo: string, sessionId: string): ProcessEntry | null;

  /** Register a new process */
  register(repo: string, sessionId: string, proc: CCProcess, owner: ClientRef): ProcessEntry;

  /** Subscribe an additional client to an existing process's output */
  subscribe(repo: string, sessionId: string, client: ClientRef): boolean;

  /** Unsubscribe a client; if no subscribers remain, destroy the process */
  unsubscribe(client: ClientRef): void;

  /** Find entry by client ref */
  findByClient(client: ClientRef): ProcessEntry | null;

  /** Remove and destroy a process entry */
  destroy(repo: string, sessionId: string): void;
}
```

#### 2. Changes to `bridge.ts`

**`handleMessage()`**: Before spawning a new CCProcess:
1. Check `processRegistry.get(repo, sessionId)` 
2. If a process already exists → `subscribe()` this client and forward the message
3. If not → spawn new process, `register()` it, subscribe self

**Event handlers (init, text, tool_use, result, etc.)**:
- Instead of sending output to one `chatId`, iterate `entry.subscribers` and send to all
- Each subscriber gets the same streaming messages, tool indicators, usage footers

**`/new`, `/continue`, process exit**:
- On `/new`: unsubscribe from current process, clear session
- On process exit: notify all subscribers, remove entry
- On `/continue`: subscribe to existing process if one is running

#### 3. Changes to event wiring in `spawnCCProcess()`

Currently events are wired to a single `(agentId, userId, chatId)`. Change to:
- Store events handlers that look up subscribers from the registry
- Broadcast to all subscribers

```typescript
proc.on('text', (text: string) => {
  const entry = this.processRegistry.findByProcess(proc);
  if (!entry) return;
  for (const sub of entry.subscribers) {
    const agent = this.agents.get(sub.agentId)!;
    // send text to sub.chatId via agent.tgBot
  }
});
```

#### 4. StreamAccumulator per-subscriber

Each subscriber needs its own `StreamAccumulator` (tracks message IDs, tool indicators for that specific TG chat). The CC process is shared, but the TG rendering is per-client.

```
ProcessEntry
  └─ subscribers: Map<string, {
       clientRef: ClientRef,
       accumulator: StreamAccumulator
     }>
```

### What NOT to change

- Session store (still per-agent, per-user) — each agent tracks its own session state
- CC process spawning logic — same as today, just goes through registry
- MCP server — still per agent-user pair
- `/model`, `/repo` — these affect user state, not the shared process directly

### Edge Cases

1. **Different models**: If agent A is on `opus` and agent B on `sonnet` for the same session — the process was spawned with one model. Second client inherits the running process's model. Show a notice.

2. **Message ordering**: Messages from multiple clients go to the same CC stdin. They'll be processed sequentially (CC is single-threaded). This is fine — it's like two people typing in the same conversation.

3. **Process death**: All subscribers get notified. Next message from any subscriber respawns.

4. **Unsubscribe on /new**: Only affects that client. Process lives as long as ≥1 subscriber remains.

### Migration Path

1. Add `ProcessRegistry` class
2. Refactor `bridge.ts` to use registry for get/create/destroy
3. Move event wiring to broadcast pattern  
4. Add per-subscriber `StreamAccumulator`
5. Update `/sessions`, `/continue`, `/new` to work with registry

### Files to modify
- `src/process-registry.ts` — NEW
- `src/bridge.ts` — refactor process management to use registry
- `src/streaming.ts` — no changes needed (one accumulator per subscriber)
