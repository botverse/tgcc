#!/usr/bin/env node
/**
 * tgcc-relay — Socket daemon that bridges TGCC (host) ↔ CC CLI (container).
 *
 * Runs inside the Docker container. Listens on a Unix socket for commands from
 * TGCC on the host and relays them to a CC CLI subprocess via stdio.
 *
 * Protocol (JSON-over-newline on Unix socket):
 *
 * Host → Container:
 *   {"type":"spawn","args":["--model","sonnet","--permission-mode","plan",...]}
 *   {"type":"message","content":{...CC UserMessage JSON...}}
 *   {"type":"kill"}
 *   {"type":"cancel"}
 *   {"type":"tool_result","tool_use_id":"abc","content":"approved"}
 *   {"type":"permission_response","request_id":"abc","allowed":true}
 *
 * Container → Host:
 *   {"type":"spawned","pid":1234}
 *   {"type":"stream","event":{...CC NDJSON output event...}}
 *   {"type":"exited","code":0,"signal":null}
 *   {"type":"error","message":"..."}
 */

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { unlinkSync, existsSync } from 'node:fs';

const SOCKET_PATH = process.env.TGCC_RELAY_SOCKET || '/run/tgcc/bridge.sock';
const CC_BINARY = process.env.CC_BINARY || 'claude';

let ccProcess = null;
let activeConnection = null;

function log(msg) {
  process.stderr.write(`[tgcc-relay] ${msg}\n`);
}

function sendToHost(obj) {
  if (activeConnection && !activeConnection.destroyed) {
    activeConnection.write(JSON.stringify(obj) + '\n');
  }
}

function spawnCC(args) {
  if (ccProcess) {
    // Check if the process is actually alive
    let alive = false;
    try { process.kill(ccProcess.pid, 0); alive = true; } catch { /* dead */ }

    if (alive) {
      // CC is still running — reuse it instead of killing and re-spawning
      log(`Reusing existing CC process (pid=${ccProcess.pid})`);
      sendToHost({ type: 'spawned', pid: ccProcess.pid });
      return;
    } else {
      log('Clearing stale CC process reference (already dead)');
      ccProcess = null;
    }
  }

  log(`Spawning: ${CC_BINARY} ${args.join(' ')}`);

  const child = spawn(CC_BINARY, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: '/home/project',
    env: { ...process.env },
  });

  ccProcess = child;

  sendToHost({ type: 'spawned', pid: child.pid });

  // Relay CC stdout (NDJSON) → host socket
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      sendToHost({ type: 'stream', event });
    } catch {
      // Non-JSON line from CC — log it
      log(`CC stdout (non-JSON): ${line}`);
    }
  });

  // Relay CC stderr → log
  const stderrRl = createInterface({ input: child.stderr });
  stderrRl.on('line', (line) => {
    log(`CC stderr: ${line}`);
  });

  child.on('error', (err) => {
    log(`CC process error: ${err.message}`);
    sendToHost({ type: 'error', message: err.message });
    ccProcess = null;
  });

  child.on('exit', (code, signal) => {
    log(`CC process exited: code=${code} signal=${signal}`);
    sendToHost({ type: 'exited', code, signal });
    ccProcess = null;
  });
}

function writeToCC(data) {
  if (!ccProcess || !ccProcess.stdin || ccProcess.stdin.destroyed) {
    sendToHost({ type: 'error', message: 'No CC process running' });
    return;
  }
  const line = JSON.stringify(data);
  log(`Writing to CC stdin: ${line.slice(0, 200)}`);
  ccProcess.stdin.write(line + '\n');
}

function killCC() {
  if (!ccProcess) {
    sendToHost({ type: 'error', message: 'No CC process to kill' });
    return;
  }
  ccProcess.kill('SIGTERM');
  // Force kill after 5s
  const pid = ccProcess.pid;
  setTimeout(() => {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
  }, 5000);
}

function cancelCC() {
  if (!ccProcess) return;
  ccProcess.kill('SIGINT');
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'spawn':
      spawnCC(msg.args || []);
      break;

    case 'message':
      // msg.content is a CC UserMessage (JSON object to write to stdin)
      writeToCC(msg.content);
      break;

    case 'kill':
      killCC();
      break;

    case 'cancel':
      cancelCC();
      break;

    case 'tool_result':
      // Forward tool result to CC stdin
      writeToCC({
        type: 'tool_result',
        tool_use_id: msg.tool_use_id,
        content: msg.content,
      });
      break;

    case 'permission_response':
      writeToCC({
        type: 'permission_response',
        request_id: msg.request_id,
        allowed: msg.allowed,
      });
      break;

    case 'ping':
      sendToHost({ type: 'pong', pid: ccProcess?.pid ?? null });
      break;

    default:
      sendToHost({ type: 'error', message: `Unknown message type: ${msg.type}` });
  }
}

// Clean up stale socket
if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
}

const server = createServer((connection) => {
  log('Host connected');

  // Only allow one connection at a time
  if (activeConnection && !activeConnection.destroyed) {
    log('Replacing existing connection');
    activeConnection.destroy();
  }
  activeConnection = connection;

  const rl = createInterface({ input: connection });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (err) {
      log(`Invalid message: ${err.message}`);
      sendToHost({ type: 'error', message: `Invalid JSON: ${err.message}` });
    }
  });

  connection.on('error', (err) => {
    log(`Connection error: ${err.message}`);
  });

  connection.on('close', () => {
    log('Host disconnected');
    if (activeConnection === connection) {
      activeConnection = null;
    }
  });
});

server.listen(SOCKET_PATH, () => {
  log(`Listening on ${SOCKET_PATH}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  log('SIGTERM received, shutting down');
  if (ccProcess) ccProcess.kill('SIGTERM');
  server.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received, shutting down');
  if (ccProcess) ccProcess.kill('SIGTERM');
  server.close();
  process.exit(0);
});
