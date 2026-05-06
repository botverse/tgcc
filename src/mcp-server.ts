import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { McpBridgeClient, type McpToolRequest } from './mcp-bridge.js';

// ── MCP Server ──
// Spawned as a child of CC. Communicates with the bridge via Unix socket.

const AGENT_ID = process.env.TGCC_AGENT_ID ?? 'unknown';
const USER_ID = process.env.TGCC_USER_ID ?? 'unknown';
const SOCKET_PATH = process.env.TGCC_SOCKET ?? '/tmp/tgcc/sockets/default.sock';
const CAPABILITIES = new Set((process.env.TGCC_CAPABILITIES ?? '').split(',').filter(Boolean));
const hasCap = (cap: string): boolean => CAPABILITIES.has('*') || CAPABILITIES.has(cap);

async function main(): Promise<void> {
  const client = new McpBridgeClient(SOCKET_PATH);

  try {
    await client.connect();
  } catch (err) {
    // Bridge might not be ready yet — tools will retry on each call
  }

  const server = new McpServer({
    name: 'tgcc',
    version: '0.1.0',
  });

  // ── send_file tool ──

  server.tool(
    'send_file',
    'Send a file to the user on Telegram. Use this when you want to deliver a file (image, PDF, code, etc.) to the user.',
    {
      path: z.string().describe('Absolute path to the file to send'),
      caption: z.string().optional().describe('Optional caption for the file'),
    },
    async ({ path, caption }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'send_file',
        agentId: AGENT_ID,
        userId: USER_ID,
        params: { path, caption },
      };

      try {
        const response = await client.sendRequest(request);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: `File sent to user: ${path}` }] };
        }
        return { content: [{ type: 'text' as const, text: `Failed to send file: ${response.error}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // ── send_image tool ──

  server.tool(
    'send_image',
    'Send an image to the user on Telegram with a nice preview. Use for generated charts, screenshots, diagrams.',
    {
      path: z.string().describe('Absolute path to the image file'),
      caption: z.string().optional().describe('Optional caption'),
    },
    async ({ path, caption }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'send_image',
        agentId: AGENT_ID,
        userId: USER_ID,
        params: { path, caption },
      };

      try {
        const response = await client.sendRequest(request);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: `Image sent to user: ${path}` }] };
        }
        return { content: [{ type: 'text' as const, text: `Failed to send image: ${response.error}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // ── send_message tool ──

  server.tool(
    'send_message',
    'Out-of-band Telegram notification. Your normal assistant text already renders to the user\'s chat automatically — do NOT call this for replies, greetings, summaries, or anything you can just say in your text response. Reserve only for alerts the user must see outside the current interactive turn (e.g. async background work, heartbeat wake-ups, long-running tasks). Calling this during an interactive reply duplicates your output and creates noise.',
    {
      text: z.string().describe('Message text (plain text, no HTML)'),
    },
    async ({ text }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'send_message',
        agentId: AGENT_ID,
        userId: USER_ID,
        params: { text },
      };

      try {
        const response = await client.sendRequest(request);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: 'Message sent to user.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Failed to send message: ${response.error}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // ── send_voice tool ──

  server.tool(
    'send_voice',
    'Send a voice message to the user on Telegram.',
    {
      path: z.string().describe('Path to .ogg opus audio file'),
      caption: z.string().optional().describe('Optional caption'),
    },
    async ({ path, caption }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'send_voice',
        agentId: AGENT_ID,
        userId: USER_ID,
        params: { path, caption },
      };

      try {
        const response = await client.sendRequest(request);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: `Voice message sent to user: ${path}` }] };
        }
        return { content: [{ type: 'text' as const, text: `Failed to send voice: ${response.error}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // ── notify_supervisor tool ──

  server.tool(
    'notify_supervisor',
    'Send a message to the supervisor that manages this agent. Bidirectional: the supervisor receives your message, can reply, and you are automatically woken when their turn completes — same wake-on-complete mechanism as tgcc_send. PREFER THIS over tgcc_send when addressing the supervisor: it resolves the supervisor\'s agentId automatically (tgcc_send requires you to know it). Use for asking questions, reporting blockers, escalations, or progress updates.',
    {
      message: z.string().describe('Message to send to the supervisor'),
      priority: z.enum(['info', 'question', 'blocker']).default('info').describe('Message priority'),
    },
    async ({ message, priority }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'notify_supervisor',
        agentId: AGENT_ID,
        userId: USER_ID,
        params: { message, priority },
      };

      try {
        const response = await client.sendRequest(request);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: 'Message sent to parent.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // ── supervisor_exec tool ──

  server.tool(
    'supervisor_exec',
    'Request the supervisor to execute a shell command. The supervisor may reject unsafe commands.',
    {
      command: z.string().describe('Shell command to execute'),
      timeoutMs: z.number().default(60000).describe('Timeout in milliseconds'),
    },
    async ({ command, timeoutMs }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'supervisor_exec',
        agentId: AGENT_ID,
        userId: USER_ID,
        params: { command, timeoutMs },
      };

      try {
        const response = await client.sendRequest(request, timeoutMs + 5000);
        if (response.success) {
          const resultStr = response.result ? JSON.stringify(response.result) : 'Command executed.';
          return { content: [{ type: 'text' as const, text: resultStr }] };
        }
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // ── supervisor_notify tool ──

  server.tool(
    'supervisor_notify',
    'Send a notification through the supervisor to the user.',
    {
      title: z.string().describe('Notification title'),
      body: z.string().describe('Notification body'),
      priority: z.enum(['passive', 'active', 'timeSensitive']).default('active').describe('Notification priority'),
    },
    async ({ title, body, priority }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'supervisor_notify',
        agentId: AGENT_ID,
        userId: USER_ID,
        params: { title, body, priority },
      };

      try {
        const response = await client.sendRequest(request);
        if (response.success) {
          return { content: [{ type: 'text' as const, text: 'Notification sent.' }] };
        }
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
          isError: true,
        };
      }
    }
  );

  // ── Agent tools (available to ALL agents) ──

  server.tool(
    'tgcc_agents',
    'List all registered agents (id, repo, model, state, ephemeral, isSupervisor). Exactly one entry has `isSupervisor: true` (the configured supervisor) and is sorted first. To address the supervisor, ALWAYS use `notify_supervisor` — it routes by configured id and bypasses the picker. Use this list only to discover WORKER agentIds for `tgcc_send` / `tgcc_spawn`.',
    {},
    async () => {
      const request: McpToolRequest = {
        id: uuidv4(), tool: 'tgcc_agents', agentId: AGENT_ID, userId: USER_ID,
        params: {},
      };
      try {
        const response = await client.sendRequest(request);
        if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
      }
    }
  );

  server.tool(
    'tgcc_status',
    'Get status of worker agents (state, context%, last activity). Omit agentId to get all workers.',
    {
      agentId: z.string().optional().describe('Specific worker agent ID, or omit for all'),
    },
    async ({ agentId }) => {
      const request: McpToolRequest = {
        id: uuidv4(), tool: 'tgcc_status', agentId: AGENT_ID, userId: USER_ID,
        params: { agentId },
      };
      try {
        const response = await client.sendRequest(request);
        if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
      }
    }
  );

  server.tool(
    'tgcc_send',
    'Send a message to a specific WORKER agent by id. Spawns CC if not running. The calling agent is automatically woken when the target\'s turn completes, with the sent message and reply included in the wake context. To address the SUPERVISOR, use `notify_supervisor` instead — it has the same wake-on-complete reply mechanism and resolves the supervisor\'s id automatically (avoids picking the wrong agent). Use `tgcc_agents` to discover worker agentIds.',
    {
      agentId: z.string().describe('Target worker agent ID'),
      text: z.string().describe('Message or task to send'),
      newSession: z.boolean().optional().describe('Clear session before sending'),
      followUp: z.boolean().optional().describe('Only send if CC is already active (no spawn)'),
      waitForIdle: z.boolean().optional().describe('Queue message and deliver after the agent finishes its current turn. If already idle, sends immediately.'),
      sessionId: z.string().optional().describe('Session ID to target'),
    },
    async ({ agentId, text, newSession, followUp, waitForIdle, sessionId }) => {
      const request: McpToolRequest = {
        id: uuidv4(), tool: 'tgcc_send', agentId: AGENT_ID, userId: USER_ID,
        params: { agentId, text, newSession, followUp, waitForIdle, sessionId },
      };
      try {
        const response = await client.sendRequest(request, 10000);
        if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result) }] };
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
      }
    }
  );

  server.tool(
    'tgcc_log',
    'Read the event log for a worker agent (tool calls, errors, text output, system events).',
    {
      agentId: z.string().describe('Worker agent ID'),
      limit: z.number().optional().describe('Max entries to return (default 50)'),
      since: z.number().optional().describe('Only entries from last N milliseconds'),
      type: z.enum(['text', 'tool', 'system', 'error', 'user']).optional().describe('Filter by entry type'),
      grep: z.string().optional().describe('Filter by regex pattern'),
    },
    async ({ agentId, limit, since, type, grep }) => {
      const request: McpToolRequest = {
        id: uuidv4(), tool: 'tgcc_log', agentId: AGENT_ID, userId: USER_ID,
        params: { agentId, limit, since, type, grep },
      };
      try {
        const response = await client.sendRequest(request);
        if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
      }
    }
  );

  server.tool(
    'tgcc_spawn',
    `Spawn a temporary (ephemeral) agent with a CC process. Three modes:
1. Fire & forget: set message — returns immediately, agent runs in background
2. Async wake: use tgcc_send after spawn — you get woken when the agent's turn completes with reply context
3. Sync (waitForResult): set message + waitForResult:true — blocks until agent completes, returns its text output, auto-destroys
Call tgcc_agents first to discover available agents and repos.`,
    {
      agentId: z.string().optional().describe('Agent ID for the ephemeral agent. Auto-generated if omitted.'),
      repo: z.string().describe('Absolute path to the repository for the CC process'),
      model: z.string().optional().describe('Model to use (default: sonnet)'),
      message: z.string().optional().describe('Initial prompt to send immediately after spawning'),
      timeoutMs: z.number().optional().describe('Auto-destroy after this many milliseconds (default 120s for waitForResult)'),
      permissionMode: z.string().optional().describe('Permission mode: dangerously-skip, acceptEdits, default, plan'),
      waitForResult: z.boolean().optional().describe('Block until agent completes and return its text output. Auto-destroys after. Default timeout 120s.'),
      allowedTools: z.array(z.string()).optional().describe('Restrict the child to ONLY these tools (CC --allowed-tools). Names are tool ids like "Read", "Bash", or MCP-prefixed "mcp__server__tool". Useful for L1 scorers in fanout — block write tools and further recursion.'),
      disallowedTools: z.array(z.string()).optional().describe('Block these specific tools in the child (CC --disallowed-tools). Use to prevent recursion ("tgcc_spawn"), block write side-effects, or mask user-scope MCP tools the child shouldn\'t see.'),
    },
    async ({ agentId, repo, model, message, timeoutMs, permissionMode, waitForResult, allowedTools, disallowedTools }) => {
      const request: McpToolRequest = {
        id: uuidv4(), tool: 'tgcc_spawn', agentId: AGENT_ID, userId: USER_ID,
        params: { agentId, repo, model, message, timeoutMs, permissionMode, waitForResult, allowedTools, disallowedTools },
      };
      const socketTimeout = waitForResult ? ((timeoutMs || 120_000) + 15_000) : 15_000;
      try {
        const response = await client.sendRequest(request, socketTimeout);
        if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
      }
    }
  );

  server.tool(
    'tgcc_destroy',
    'Destroy an ephemeral agent. Kills its CC process if running and removes it from the registry. Only works on ephemeral agents.',
    {
      agentId: z.string().describe('Ephemeral agent ID to destroy'),
    },
    async ({ agentId }) => {
      const request: McpToolRequest = {
        id: uuidv4(), tool: 'tgcc_destroy', agentId: AGENT_ID, userId: USER_ID,
        params: { agentId },
      };
      try {
        const response = await client.sendRequest(request);
        if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
        return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
      }
    }
  );

  // ── ralph_done tool (only for ralph instances via watch:self capability) ──

  if (hasCap('watch:self')) {
    server.tool(
      'ralph_done',
      'Declare that the watched task is complete. Sends summary to user, then self-destructs. Only callable by Ralph agents.',
      {
        summary: z.string().describe('Brief summary of what the worker accomplished'),
        success: z.boolean().default(true).describe('Whether the task completed successfully'),
      },
      async ({ summary, success }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'ralph_done', agentId: AGENT_ID, userId: USER_ID,
          params: { summary, success },
        };
        try {
          const response = await client.sendRequest(request);
          if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
          return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
        }
      }
    );
  }

  // ── Capability-gated tools ──
  // Capabilities: * (all), observe (status/log/track), manage (session/kill/destroy),
  // schedule (cron), watch:self (ralph_done), basic (agents/send/spawn)

  if (hasCap('manage')) {

    server.tool(
      'tgcc_kill',
      'Kill a worker agent\'s CC process. The agent registration is preserved.',
      {
        agentId: z.string().describe('Worker agent ID to kill'),
      },
      async ({ agentId }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_kill', agentId: AGENT_ID, userId: USER_ID,
          params: { agentId },
        };
        try {
          const response = await client.sendRequest(request);
          if (response.success) return { content: [{ type: 'text' as const, text: `Killed ${agentId}` }] };
          return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
        }
      }
    );

    server.tool(
      'tgcc_session',
      'Manage a worker agent\'s session lifecycle without sending a message.',
      {
        agentId: z.string().describe('Worker agent ID'),
        action: z.enum(['list', 'new', 'cancel', 'set_model', 'continue', 'resume', 'compact', 'set_repo', 'set_permissions']).describe('Action to perform'),
        sessionId: z.string().optional().describe('For resume action: session ID'),
        model: z.string().optional().describe('For set_model action: model name'),
        limit: z.number().optional().describe('For list action: max sessions to return'),
        repo: z.string().optional().describe('For set_repo action: repository path or alias'),
        mode: z.string().optional().describe('For set_permissions action: permission mode (dangerously-skip, acceptEdits, default, plan)'),
        instructions: z.string().optional().describe('For compact action: optional compaction instructions'),
        prompt: z.string().optional().describe('For new action: initial prompt to send immediately after creating the fresh session'),
      },
      async ({ agentId, action, sessionId, model, limit, repo, mode, instructions, prompt }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_session', agentId: AGENT_ID, userId: USER_ID,
          params: { agentId, action, sessionId, model, limit, repo, mode, instructions, prompt },
        };
        try {
          const response = await client.sendRequest(request);
          if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result ?? { ok: true }, null, 2) }] };
          return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
        }
      }
    );

  }

  if (hasCap('observe')) {

    server.tool(
      'tgcc_track',
      'Start receiving high-signal events from a worker agent in real time (build results, failures, commits, task progress). Tracking persists until the supervisor session ends or explicit tgcc_untrack. Note: tgcc_send automatically tracks the target worker.',
      {
        agentId: z.string().describe('Worker agent ID to track'),
        heartbeatMs: z.number().optional().describe('Periodic heartbeat interval in milliseconds (min 30000). Wakes the supervisor with tracked worker status (state, context%, cost). Omit to keep current heartbeat or disable.'),
      },
      async ({ agentId, heartbeatMs }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_track', agentId: AGENT_ID, userId: USER_ID,
          params: { agentId, heartbeatMs },
        };
        try {
          const response = await client.sendRequest(request);
          if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result) }] };
          return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
        }
      }
    );

    server.tool(
      'tgcc_untrack',
      'Stop receiving real-time high-signal events from a worker agent. Events are still queued and delivered when the supervisor session starts.',
      {
        agentId: z.string().describe('Worker agent ID to stop tracking'),
      },
      async ({ agentId }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_untrack', agentId: AGENT_ID, userId: USER_ID,
          params: { agentId },
        };
        try {
          const response = await client.sendRequest(request);
          if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result) }] };
          return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
        }
      }
    );

  }

  if (hasCap('schedule')) {

    server.tool(
      'tgcc_cron',
      'Manage scheduled cron jobs for worker agents. Use to schedule periodic nudges (e.g. "check training status every 30m") or one-shot reminders.',
      {
        action: z.enum(['add', 'list', 'remove', 'trigger']).describe('Action to perform'),
        agentId: z.string().optional().describe('Target agent ID (required for add). Use "self" to target yourself.'),
        message: z.string().optional().describe('Message to send when job fires (required for add)'),
        every: z.string().optional().describe('Recurring interval, e.g. "30m", "4h"'),
        at: z.string().optional().describe('One-shot delay, e.g. "20m", "2h", or ISO datetime'),
        cron: z.string().optional().describe('Raw cron expression, e.g. "*/30 * * * *"'),
        tz: z.string().optional().describe('IANA timezone, e.g. "America/New_York"'),
        name: z.string().optional().describe('Human-readable job name (also used as ID slug)'),
        session: z.enum(['main', 'isolated']).optional().describe('Execution mode (default: main)'),
        jobId: z.string().optional().describe('Job ID (required for remove/trigger)'),
      },
      async ({ action, agentId, message, every, at, cron, tz, name, session, jobId }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_cron', agentId: AGENT_ID, userId: USER_ID,
          params: { action, agentId, message, every, at, cron, tz, name, session, jobId },
        };
        try {
          const response = await client.sendRequest(request);
          if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
          return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
        }
      }
    );

  }

  if (hasCap('manage')) {

    server.tool(
      'tgcc_ralph',
      'Spawn a Ralph completion shepherd to watch a worker agent until it finishes. Ralph monitors turn completions, can intervene, and notifies you when done.',
      {
        agentId: z.string().describe('Target worker agent ID to watch'),
        prompt: z.string().optional().describe('What Ralph should ensure the worker completes. If omitted, Ralph infers the task from the worker\'s session history.'),
        spec: z.string().optional().describe('Spec text or acceptance criteria for Ralph to verify against. When provided, Ralph will verify the output matches the spec (including visual fidelity for UI/game projects).'),
        timeoutMs: z.number().optional().describe('Max lifetime in ms (default: 2 hours)'),
        minTurns: z.number().optional().describe('Minimum worker turns before ralph_done is allowed (default: 3)'),
      },
      async ({ agentId, prompt, spec, timeoutMs, minTurns }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_ralph', agentId: AGENT_ID, userId: USER_ID,
          params: { agentId, prompt, spec, timeoutMs, minTurns },
        };
        try {
          const response = await client.sendRequest(request);
          if (response.success) return { content: [{ type: 'text' as const, text: JSON.stringify(response.result, null, 2) }] };
          return { content: [{ type: 'text' as const, text: `Failed: ${response.error}` }], isError: true };
        } catch (err) {
          return { content: [{ type: 'text' as const, text: `Bridge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }], isError: true };
        }
      }
    );

  }

  // Start the MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
