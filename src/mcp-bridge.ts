import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import type pino from 'pino';

// ── Types ──

export interface McpToolRequest {
  id: string;
  tool: 'send_file' | 'send_image' | 'send_voice';
  agentId: string;
  userId: string;
  params: {
    path: string;
    caption?: string;
  };
}

export interface McpToolResponse {
  id: string;
  success: boolean;
  error?: string;
}

export type McpToolHandler = (request: McpToolRequest) => Promise<McpToolResponse>;

// ── Bridge-side Unix socket server ──

export class McpBridgeServer extends EventEmitter {
  private servers = new Map<string, Server>();
  private handler: McpToolHandler;
  private logger: pino.Logger;

  constructor(handler: McpToolHandler, logger: pino.Logger) {
    super();
    this.handler = handler;
    this.logger = logger;
  }

  /** Start listening on a socket path for a specific agent-user pair */
  listen(socketPath: string): void {
    // Clean up stale socket
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
    const dir = dirname(socketPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const server = createServer((socket) => this.handleConnection(socket, socketPath));

    server.on('error', (err) => {
      this.logger.error({ err, socketPath }, 'MCP bridge socket error');
    });

    server.listen(socketPath, () => {
      this.logger.info({ socketPath }, 'MCP bridge listening');
    });

    this.servers.set(socketPath, server);
  }

  private handleConnection(socket: Socket, socketPath: string): void {
    this.logger.debug({ socketPath }, 'MCP server connected');
    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();
      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        this.processLine(line, socket);
      }
    });

    socket.on('error', (err) => {
      this.logger.debug({ err, socketPath }, 'MCP connection error');
    });
  }

  private async processLine(line: string, socket: Socket): Promise<void> {
    try {
      const request = JSON.parse(line) as McpToolRequest;
      const response = await this.handler(request);
      socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      this.logger.error({ err, line }, 'Failed to process MCP request');
      const errorResponse: McpToolResponse = {
        id: 'unknown',
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
      socket.write(JSON.stringify(errorResponse) + '\n');
    }
  }

  /** Stop listening on a specific socket */
  close(socketPath: string): void {
    const server = this.servers.get(socketPath);
    if (server) {
      server.close();
      this.servers.delete(socketPath);
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch {}
      }
    }
  }

  /** Stop all sockets */
  closeAll(): void {
    for (const [socketPath, server] of this.servers) {
      server.close();
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch {}
      }
    }
    this.servers.clear();
  }
}

// ── MCP server-side client (used by mcp-server.ts) ──

export class McpBridgeClient {
  private socketPath: string;
  private socket: Socket | null = null;
  private pendingRequests = new Map<string, { resolve: (r: McpToolResponse) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private connected = false;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = createConnection(this.socketPath);

      this.socket.on('connect', () => {
        this.connected = true;
        resolve();
      });

      this.socket.on('data', (data) => {
        this.buffer += data.toString();
        let idx: number;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 1);
          this.handleResponse(line);
        }
      });

      this.socket.on('error', (err) => {
        this.connected = false;
        reject(err);
        // Reject all pending requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(err);
        }
        this.pendingRequests.clear();
      });

      this.socket.on('close', () => {
        this.connected = false;
      });
    });
  }

  private handleResponse(line: string): void {
    try {
      const response = JSON.parse(line) as McpToolResponse;
      const pending = this.pendingRequests.get(response.id);
      if (pending) {
        this.pendingRequests.delete(response.id);
        pending.resolve(response);
      }
    } catch {}
  }

  async sendRequest(request: McpToolRequest, timeoutMs: number = 30000): Promise<McpToolResponse> {
    if (!this.connected || !this.socket) {
      // Try to reconnect
      await this.reconnect();
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(request.id);
        reject(new Error(`MCP request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(request.id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });

      this.socket!.write(JSON.stringify(request) + '\n');
    });
  }

  private async reconnect(retries: number = 5, intervalMs: number = 2000): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this.connect();
        return;
      } catch {
        if (i < retries - 1) {
          await new Promise(r => setTimeout(r, intervalMs));
        }
      }
    }
    throw new Error(`Failed to connect to bridge socket at ${this.socketPath} after ${retries} retries`);
  }

  close(): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('MCP connection closed'));
    }
    this.pendingRequests.clear();
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }
}
