#!/usr/bin/env node
/**
 * tgcc-supervisor.mjs — OpenClaw-side supervisor for TGCC.
 *
 * Registers as a supervisor on the TGCC ctl socket. Receives events
 * (stdout JSON lines) and handles privileged actions like restart_tgcc
 * that CC can't do from inside.
 *
 * Usage:
 *   node tools/tgcc-supervisor.mjs [--agent main] [--socket /tmp/tgcc/ctl/tgcc.sock]
 */

import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';

// ── Args ──

const args = process.argv.slice(2);
function getArg(name, fallback) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
}

const AGENT_ID = getArg('agent', 'main');
const SOCKET_PATH = getArg('socket', '/tmp/tgcc/ctl/tgcc.sock');
const RECONNECT_DELAY_MS = 5000;
const RESTART_RECONNECT_DELAY_MS = 2000;
const RESTART_RECONNECT_MAX_MS = 30000;

const log = (msg) => process.stderr.write(`[tgcc-supervisor] ${msg}\n`);

let socket = null;
let reconnecting = false;
let shuttingDown = false;

// ── Connect & register ──

function connectAndRegister() {
  if (shuttingDown) return;

  log(`Connecting to ${SOCKET_PATH}...`);

  socket = connect(SOCKET_PATH);
  let registered = false;

  const rl = createInterface({ input: socket });

  socket.on('connect', () => {
    log('Connected, registering as supervisor...');
    const reg = JSON.stringify({
      type: 'register_supervisor',
      agentId: AGENT_ID,
      capabilities: ['restart_tgcc', 'restart_cc', 'notify', 'status'],
    });
    socket.write(reg + '\n');
  });

  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log(`Bad JSON: ${line}`);
      return;
    }

    if (!registered) {
      if (msg.type === 'registered') {
        registered = true;
        log(`Registered as supervisor (agentId: ${msg.agentId})`);
        reconnecting = false;
        return;
      }
      if (msg.type === 'error') {
        log(`Registration error: ${msg.message}`);
        socket.destroy();
        return;
      }
    }

    // ── Handle incoming messages on established connection ──

    if (msg.type === 'event') {
      // Forward events to stdout as JSON lines
      process.stdout.write(JSON.stringify(msg) + '\n');
      return;
    }

    if (msg.type === 'request') {
      // TGCC is asking us to do something
      handleRequest(msg.requestId, msg.action, msg.params || {});
      return;
    }

    // Anything else — log and forward to stdout
    process.stdout.write(JSON.stringify(msg) + '\n');
  });

  socket.on('error', (err) => {
    if (!shuttingDown) {
      log(`Socket error: ${err.message}`);
    }
  });

  socket.on('close', () => {
    socket = null;
    if (!shuttingDown && !reconnecting) {
      log(`Connection closed. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
      reconnecting = true;
      setTimeout(() => {
        reconnecting = false;
        connectAndRegister();
      }, RECONNECT_DELAY_MS);
    }
  });
}

// ── Handle requests from TGCC ──

function handleRequest(requestId, action, params) {
  switch (action) {
    case 'restart_tgcc':
      handleRestartTgcc(requestId);
      break;

    case 'restart_cc':
      // TGCC handles this internally
      sendResponse(requestId, { note: 'handled_by_tgcc' });
      break;

    case 'status':
      // Forward to TGCC and relay response
      sendCommand(requestId, 'status', {});
      break;

    default:
      sendResponse(requestId, null, `unknown action: ${action}`);
  }
}

function handleRestartTgcc(requestId) {
  log('Restarting TGCC via tmux...');

  try {
    // Send Ctrl-C to stop current process
    execSync('tmux send-keys -t tgcc C-c', { stdio: 'ignore' });
    // Small delay
    execSync('sleep 1', { stdio: 'ignore' });
    // Send empty enter to clear any prompt
    execSync('tmux send-keys -t tgcc "" Enter', { stdio: 'ignore' });
    execSync('sleep 1', { stdio: 'ignore' });
    // Start TGCC again
    const home = homedir();
    execSync(`tmux send-keys -t tgcc "cd ${home}/Botverse/tgcc && node dist/cli.js run" Enter`, { stdio: 'ignore' });

    log('TGCC restart command sent');
    sendResponse(requestId, { restarted: true });
  } catch (err) {
    log(`Failed to restart TGCC: ${err.message}`);
    sendResponse(requestId, null, `restart failed: ${err.message}`);
  }

  // Socket will close since TGCC is restarting — enter reconnect loop
  if (socket) {
    socket.destroy();
    socket = null;
  }

  log('Entering reconnect loop for TGCC restart...');
  reconnecting = true;
  const startTime = Date.now();

  const tryReconnect = () => {
    if (shuttingDown) return;
    if (Date.now() - startTime > RESTART_RECONNECT_MAX_MS) {
      log('Reconnect timeout after TGCC restart. Falling back to normal reconnect.');
      reconnecting = false;
      setTimeout(connectAndRegister, RECONNECT_DELAY_MS);
      return;
    }
    connectAndRegister();
    // If connection fails, the 'close' handler will not trigger another reconnect
    // since reconnecting is true. We retry manually.
    setTimeout(() => {
      if (reconnecting && !socket) {
        tryReconnect();
      }
    }, RESTART_RECONNECT_DELAY_MS);
  };

  setTimeout(tryReconnect, RESTART_RECONNECT_DELAY_MS);
}

// ── Socket writes ──

function sendResponse(requestId, result, error) {
  if (!socket || socket.destroyed) return;
  const resp = error
    ? { type: 'response', requestId, error }
    : { type: 'response', requestId, result };
  try {
    socket.write(JSON.stringify(resp) + '\n');
  } catch {
    log('Failed to write response to socket');
  }
}

function sendCommand(requestId, action, params) {
  if (!socket || socket.destroyed) return;
  const cmd = { type: 'command', requestId, action, params };
  try {
    socket.write(JSON.stringify(cmd) + '\n');
  } catch {
    log('Failed to write command to socket');
  }
}

// ── Lifecycle ──

process.on('SIGTERM', () => {
  log('SIGTERM received, disconnecting...');
  shuttingDown = true;
  if (socket) socket.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  log('SIGINT received, disconnecting...');
  shuttingDown = true;
  if (socket) socket.destroy();
  process.exit(0);
});

// ── Start ──

connectAndRegister();
