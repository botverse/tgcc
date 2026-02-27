import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type pino from 'pino';

// ── Protocol types ──

export interface CtlMessageRequest {
  type: 'message';
  text: string;
  agent: string;
  session?: string;
}

export interface CtlStatusRequest {
  type: 'status';
  agent?: string;
}

export type CtlRequest = CtlMessageRequest | CtlStatusRequest;

export interface CtlAckResponse {
  type: 'ack';
  sessionId: string | null;
  state: 'active' | 'spawning' | 'idle';
}

export interface CtlAgentInfo {
  id: string;
  state: string;
  sessionId: string | null;
  repo: string;
}

export interface CtlSessionInfo {
  id: string;
  agentId: string;
  messageCount: number;
  totalCostUsd: number;
}

export interface CtlStatusResponse {
  type: 'status';
  agents: CtlAgentInfo[];
  sessions: CtlSessionInfo[];
}

export interface CtlErrorResponse {
  type: 'error';
  message: string;
}

export type CtlResponse = CtlAckResponse | CtlStatusResponse | CtlErrorResponse;

// ── Handler interface (implemented by Bridge) ──

export interface CtlHandler {
  handleCtlMessage(agentId: string, text: string, sessionId?: string): CtlAckResponse;
  handleCtlStatus(agentId?: string): CtlStatusResponse;
  registerSupervisor(agentId: string, capabilities: string[], writeFn: (line: string) => void): void;
  handleSupervisorDetach(): void;
  handleSupervisorLine(line: string): void;
}

// ── Control Server ──

export class CtlServer {
  private servers = new Map<string, Server>();
  private activeSockets = new Map<string, Set<Socket>>(); // socketPath → Set<Socket>
  private supervisorSocket: Socket | null = null;
  private handler: CtlHandler;
  private logger: pino.Logger;

  constructor(handler: CtlHandler, logger: pino.Logger) {
    this.handler = handler;
    this.logger = logger;
  }

  /** Start a control socket for a specific agent. */
  listen(socketPath: string): void {
    if (existsSync(socketPath)) {
      unlinkSync(socketPath);
    }
    const dir = dirname(socketPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // Initialize socket set for this path
    this.activeSockets.set(socketPath, new Set());

    const server = createServer((socket) => this.handleConnection(socket, socketPath));

    server.on('error', (err) => {
      this.logger.error({ err, socketPath }, 'Ctl socket error');
    });

    server.listen(socketPath, () => {
      this.logger.info({ socketPath }, 'Ctl socket listening');
    });

    this.servers.set(socketPath, server);
  }

  private handleConnection(socket: Socket, socketPath: string): void {
    this.logger.debug({ socketPath }, 'Ctl client connected');
    
    // Track this socket
    const sockets = this.activeSockets.get(socketPath);
    if (sockets) {
      sockets.add(socket);
    }

    let buffer = '';

    socket.on('data', (data) => {
      buffer += data.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        this.processLine(line, socket);
      }
    });

    socket.on('error', (err) => {
      this.logger.debug({ err, socketPath }, 'Ctl connection error');
    });

    socket.on('close', () => {
      // Remove socket from tracking when it closes
      const sockets = this.activeSockets.get(socketPath);
      if (sockets) {
        sockets.delete(socket);
      }
      // Detach supervisor if this was the supervisor socket
      if (socket === this.supervisorSocket) {
        this.supervisorSocket = null;
        this.handler.handleSupervisorDetach();
      }
    });
  }

  private processLine(line: string, socket: Socket): void {
    // Route supervisor socket lines directly to bridge
    if (socket === this.supervisorSocket) {
      this.handler.handleSupervisorLine(line);
      return;
    }

    try {
      const request = JSON.parse(line) as Record<string, unknown>;
      let response: CtlResponse;

      switch (request.type as string) {
        case 'message': {
          const msgReq = request as unknown as CtlMessageRequest;
          response = this.handler.handleCtlMessage(
            msgReq.agent,
            msgReq.text,
            msgReq.session,
          );
          break;
        }
        case 'status': {
          const statusReq = request as unknown as CtlStatusRequest;
          response = this.handler.handleCtlStatus(statusReq.agent);
          break;
        }
        case 'register_supervisor': {
          const regReq = request as unknown as { agentId?: string; capabilities?: string[] };
          const writeFn = (data: string) => { try { socket.write(data); } catch {} };
          this.handler.registerSupervisor(regReq.agentId ?? 'openclaw', regReq.capabilities ?? [], writeFn);
          this.supervisorSocket = socket;
          socket.write(JSON.stringify({ type: 'registered', agentId: regReq.agentId ?? 'openclaw' }) + '\n');
          return;
        }
        default:
          response = { type: 'error', message: `Unknown request type: ${(request as { type: string }).type}` };
      }

      socket.write(JSON.stringify(response) + '\n');
    } catch (err) {
      const errResponse: CtlErrorResponse = {
        type: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      };
      socket.write(JSON.stringify(errResponse) + '\n');
    }
  }

  /** Stop a specific control socket. */
  close(socketPath: string): void {
    const server = this.servers.get(socketPath);
    if (server) {
      // Destroy all active sockets for this server
      const sockets = this.activeSockets.get(socketPath);
      if (sockets) {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
        this.activeSockets.delete(socketPath);
      }

      server.close();
      this.servers.delete(socketPath);
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch {}
      }
    }
  }

  /** Stop all control sockets. */
  closeAll(): void {
    for (const [socketPath, server] of this.servers) {
      // Destroy all active sockets for this server
      const sockets = this.activeSockets.get(socketPath);
      if (sockets) {
        for (const socket of sockets) {
          socket.destroy();
        }
        sockets.clear();
      }

      server.close();
      if (existsSync(socketPath)) {
        try { unlinkSync(socketPath); } catch {}
      }
    }
    this.servers.clear();
    this.activeSockets.clear();
  }
}
