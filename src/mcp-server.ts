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

  // ── notify_parent tool ──

  server.tool(
    'notify_parent',
    'Send a message to the orchestrator/parent that spawned this task. Use for asking questions, reporting blockers, or progress updates.',
    {
      message: z.string().describe('Message to send to the parent'),
      priority: z.enum(['info', 'question', 'blocker']).default('info').describe('Message priority'),
    },
    async ({ message, priority }) => {
      const request: McpToolRequest = {
        id: uuidv4(),
        tool: 'notify_parent',
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

  // Start the MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
