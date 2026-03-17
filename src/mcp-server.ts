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
const IS_SUPERVISOR = process.env.TGCC_IS_SUPERVISOR === '1';

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
    'Send a text message to the user on Telegram. Use this to report findings, alerts, or anything the user should see — especially from background/heartbeat tasks where normal output is suppressed.',
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
    'Send a message to the supervisor that manages this agent. Use for asking questions, reporting blockers, or progress updates.',
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

  // ── Supervisor-only tools ──

  if (IS_SUPERVISOR) {

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
      'Send a message or task to a worker agent. Spawns CC if not running. Always wakes the supervisor when the worker\'s turn completes.',
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
      },
      async ({ agentId, action, sessionId, model, limit, repo, mode, instructions }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_session', agentId: AGENT_ID, userId: USER_ID,
          params: { agentId, action, sessionId, model, limit, repo, mode, instructions },
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
      'Spawn a temporary (ephemeral) agent with a CC process. The agent auto-destroys on session end or explicit tgcc_destroy. No Telegram bot — supervisor only.',
      {
        agentId: z.string().optional().describe('Agent ID for the ephemeral agent. Auto-generated if omitted.'),
        repo: z.string().describe('Absolute path to the repository for the CC process'),
        model: z.string().optional().describe('Model to use (default: sonnet)'),
        message: z.string().optional().describe('Initial prompt to send immediately after spawning'),
        timeoutMs: z.number().optional().describe('Auto-destroy after this many milliseconds'),
        permissionMode: z.string().optional().describe('Permission mode: dangerously-skip, acceptEdits, default, plan'),
      },
      async ({ agentId, repo, model, message, timeoutMs, permissionMode }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_spawn', agentId: AGENT_ID, userId: USER_ID,
          params: { agentId, repo, model, message, timeoutMs, permissionMode },
        };
        try {
          const response = await client.sendRequest(request, 15000);
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

    server.tool(
      'tgcc_track',
      'Start receiving high-signal events from a worker agent in real time (build results, failures, commits, task progress). Tracking persists until the supervisor session ends or explicit tgcc_untrack. Note: tgcc_send automatically tracks the target worker.',
      {
        agentId: z.string().describe('Worker agent ID to track'),
      },
      async ({ agentId }) => {
        const request: McpToolRequest = {
          id: uuidv4(), tool: 'tgcc_track', agentId: AGENT_ID, userId: USER_ID,
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

  // Start the MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
