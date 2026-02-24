import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection, type Socket } from 'node:net';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CtlServer,
  type CtlHandler,
  type CtlAckResponse,
  type CtlStatusResponse,
  type CtlResponse,
} from '../src/ctl-server.js';

const testDir = join(tmpdir(), `tgcc-ctl-test-${Date.now()}`);

function createMockHandler(): CtlHandler {
  return {
    handleCtlMessage: vi.fn().mockReturnValue({
      type: 'ack',
      sessionId: 'sess-123',
      state: 'active',
    } satisfies CtlAckResponse),
    handleCtlStatus: vi.fn().mockReturnValue({
      type: 'status',
      agents: [{ id: 'test', state: 'active', sessionId: 'sess-123', repo: '/test' }],
      sessions: [],
    } satisfies CtlStatusResponse),
  };
}

function sendAndReceive(socketPath: string, request: object): Promise<CtlResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, idx)));
      }
    });

    socket.on('error', reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
  });
}

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn().mockReturnThis(),
} as any;

describe('CtlServer', () => {
  let server: CtlServer;
  let handler: CtlHandler;
  let socketPath: string;

  beforeEach(() => {
    if (!existsSync(testDir)) mkdirSync(testDir, { recursive: true });
    socketPath = join(testDir, `test-${Date.now()}.sock`);
    handler = createMockHandler();
    server = new CtlServer(handler, mockLogger);
  });

  afterEach(() => {
    server.closeAll();
  });

  it('accepts connections and routes message requests', async () => {
    server.listen(socketPath);
    // Give the server a moment to bind
    await new Promise(r => setTimeout(r, 100));

    const response = await sendAndReceive(socketPath, {
      type: 'message',
      text: 'hello',
      agent: 'test',
    });

    expect(response.type).toBe('ack');
    expect((response as CtlAckResponse).sessionId).toBe('sess-123');
    expect((response as CtlAckResponse).state).toBe('active');
    expect(handler.handleCtlMessage).toHaveBeenCalledWith('test', 'hello', undefined);
  });

  it('routes status requests', async () => {
    server.listen(socketPath);
    await new Promise(r => setTimeout(r, 100));

    const response = await sendAndReceive(socketPath, {
      type: 'status',
      agent: 'test',
    });

    expect(response.type).toBe('status');
    expect((response as CtlStatusResponse).agents).toHaveLength(1);
    expect(handler.handleCtlStatus).toHaveBeenCalledWith('test');
  });

  it('returns error for unknown request types', async () => {
    server.listen(socketPath);
    await new Promise(r => setTimeout(r, 100));

    const response = await sendAndReceive(socketPath, {
      type: 'unknown',
    });

    expect(response.type).toBe('error');
  });

  it('returns error for invalid JSON', async () => {
    server.listen(socketPath);
    await new Promise(r => setTimeout(r, 100));

    const response = await new Promise<CtlResponse>((resolve, reject) => {
      const socket = createConnection(socketPath);
      let buffer = '';
      socket.on('connect', () => socket.write('not json\n'));
      socket.on('data', (data) => {
        buffer += data.toString();
        const idx = buffer.indexOf('\n');
        if (idx !== -1) {
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, idx)));
        }
      });
      socket.on('error', reject);
    });

    expect(response.type).toBe('error');
  });

  it('cleans up socket file on close', async () => {
    server.listen(socketPath);
    await new Promise(r => setTimeout(r, 100));
    expect(existsSync(socketPath)).toBe(true);

    server.close(socketPath);
    // Socket file should be cleaned up
    expect(existsSync(socketPath)).toBe(false);
  });

  it('passes session id for message requests', async () => {
    server.listen(socketPath);
    await new Promise(r => setTimeout(r, 100));

    await sendAndReceive(socketPath, {
      type: 'message',
      text: 'test',
      agent: 'test',
      session: 'sess-456',
    });

    expect(handler.handleCtlMessage).toHaveBeenCalledWith('test', 'test', 'sess-456');
  });
});
