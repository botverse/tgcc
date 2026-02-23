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

  // Start the MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP server error: ${err}\n`);
  process.exit(1);
});
