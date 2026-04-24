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

// CLI session protocol (persistent bidirectional socket, like register_supervisor)

export interface CtlCliAttachRequest {
  type: 'cli_attach';
  agent: string;
  repo: string;
}

export interface CtlCliEventRequest {
  type: 'cli_event';
  event: 'state' | 'session';
  data: { state?: 'thinking' | 'idle'; sessionId?: string };
}

export interface CtlCliDetachRequest {
  type: 'cli_detach';
}

/** Daemon → CLI: inject text into CC's PTY. */
export interface CtlCliInjectCommand {
  type: 'cli_inject';
  text: string;
}

/** Daemon → CLI: kill CC process. */
export interface CtlCliKillCommand {
  type: 'cli_kill';
}

/** Daemon → CLI: cancel (SIGINT) CC process. */
export interface CtlCliCancelCommand {
  type: 'cli_cancel';
}

export interface CtlCliAttachedResponse {
  type: 'cli_attached';
  mcpConfigPath: string;
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
  /** CLI session attached — returns MCP config path for the agent. */
  handleCliAttach(agentId: string, repo: string, writeFn: (line: string) => void): CtlCliAttachedResponse;
  /** CLI session forwarded a state/session event. */
  handleCliEvent(agentId: string, event: string, data: Record<string, unknown>): void;
  /** CLI session detached (socket closed or explicit detach). */
  handleCliDetach(agentId: string): void;
}

// ── Control Server ──

export class CtlServer {
  private servers = new Map<string, Server>();
  private activeSockets = new Map<string, Set<Socket>>(); // socketPath → Set<Socket>
  private supervisorSocket: Socket | null = null;
  private cliSockets = new Map<string, Socket>(); // agentId → persistent CLI socket
  private handler: CtlHandler;
  private logger: pino.Logger;
  private defaultSupervisorId: string | null;

  constructor(handler: CtlHandler, logger: pino.Logger, defaultSupervisorId: string | null = null) {
    this.handler = handler;
    this.logger = logger;
    this.defaultSupervisorId = defaultSupervisorId;
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
      // Detach CLI session if this was a CLI socket
      for (const [agentId, cliSocket] of this.cliSockets) {
        if (cliSocket === socket) {
          this.cliSockets.delete(agentId);
          this.handler.handleCliDetach(agentId);
          break;
        }
      }
    });
  }

  /** Send a command to a CLI session's persistent socket. */
  sendToCliSocket(agentId: string, command: CtlCliInjectCommand | CtlCliKillCommand | CtlCliCancelCommand): boolean {
    const cliSocket = this.cliSockets.get(agentId);
    if (!cliSocket) return false;
    try {
      cliSocket.write(JSON.stringify(command) + '\n');
      return true;
    } catch {
      return false;
    }
  }

  /** Check if an agent has an active CLI session. */
  hasCliSession(agentId: string): boolean {
    return this.cliSockets.has(agentId);
  }

  private processLine(line: string, socket: Socket): void {
    // Route supervisor socket lines directly to bridge
    if (socket === this.supervisorSocket) {
      this.handler.handleSupervisorLine(line);
      return;
    }

    // Route CLI socket lines (after cli_attach) to handler
    for (const [agentId, cliSocket] of this.cliSockets) {
      if (cliSocket === socket) {
        this.processCliLine(line, agentId);
        return;
      }
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
          const resolvedId = regReq.agentId ?? this.defaultSupervisorId;
          if (!resolvedId) {
            socket.write(JSON.stringify({ type: 'error', message: 'No agentId provided and no default supervisor configured' } satisfies CtlErrorResponse) + '\n');
            return;
          }
          const writeFn = (data: string) => { try { socket.write(data); } catch {} };
          this.handler.registerSupervisor(resolvedId, regReq.capabilities ?? [], writeFn);
          this.supervisorSocket = socket;
          socket.write(JSON.stringify({ type: 'registered', agentId: resolvedId }) + '\n');
          return;
        }
        case 'cli_attach': {
          const attachReq = request as unknown as CtlCliAttachRequest;
          const writeFn = (data: string) => { try { socket.write(data); } catch {} };
          const attachResp = this.handler.handleCliAttach(attachReq.agent, attachReq.repo, writeFn);
          // Register this as a persistent CLI socket
          this.cliSockets.set(attachReq.agent, socket);
          socket.write(JSON.stringify(attachResp) + '\n');
          this.logger.info({ agentId: attachReq.agent }, 'CLI session attached');
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

  /** Process a line from an already-attached CLI socket. */
  private processCliLine(line: string, agentId: string): void {
    try {
      const request = JSON.parse(line) as Record<string, unknown>;

      switch (request.type as string) {
        case 'cli_event': {
          const evReq = request as unknown as CtlCliEventRequest;
          this.handler.handleCliEvent(agentId, evReq.event, evReq.data);
          break;
        }
        case 'cli_detach': {
          this.cliSockets.delete(agentId);
          this.handler.handleCliDetach(agentId);
          this.logger.info({ agentId }, 'CLI session detached');
          break;
        }
        default:
          this.logger.warn({ agentId, type: request.type }, 'Unknown CLI request type');
      }
    } catch (err) {
      this.logger.debug({ err, agentId }, 'Failed to parse CLI line');
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
