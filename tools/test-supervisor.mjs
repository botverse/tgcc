#!/usr/bin/env node
/**
 * Quick test for supervisor protocol.
 * Connects to ctl socket, registers as supervisor, sends a message, waits for result.
 *
 * Usage: node tools/test-supervisor.mjs [agentId] [message]
 */
import { connect } from 'node:net';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const agentId = process.argv[2] || 'sentinella';
const text = process.argv[3] || 'What git branch are you on? One word answer.';
const SOCKET = '/tmp/tgcc/ctl/tgcc.sock';

const socket = connect(SOCKET);
const rl = createInterface({ input: socket });

function send(obj) {
  const line = JSON.stringify(obj);
  console.log(`→ ${line}`);
  socket.write(line + '\n');
}

socket.on('connect', () => {
  console.log(`Connected to ${SOCKET}`);
  
  // Register as supervisor
  send({ type: 'register_supervisor', agentId: 'test', capabilities: [] });
});

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  console.log(`← ${JSON.stringify(msg, null, 2)}`);
  
  if (msg.type === 'registered') {
    // Send status first to see current state
    send({ type: 'command', requestId: randomUUID(), action: 'status' });
  }
  
  if (msg.type === 'response' && msg.result?.agents) {
    // Status received — now send message
    console.log('\n--- Sending message ---');
    send({
      type: 'command',
      requestId: randomUUID(),
      action: 'send_message',
      params: { agentId, text, subscribe: true }
    });
  }
  
  if (msg.type === 'event' && msg.event === 'result') {
    console.log('\n=== RESULT ===');
    console.log(msg.text || '(no text)');
    console.log(`Cost: $${msg.cost_usd || 0}`);
    process.exit(0);
  }
  
  if (msg.type === 'event' && msg.event === 'process_exit') {
    console.log('\n=== PROCESS EXITED ===');
    process.exit(0);
  }
});

socket.on('error', (err) => {
  console.error('Socket error:', err.message);
  process.exit(1);
});

// Timeout after 120s
setTimeout(() => {
  console.error('Timeout waiting for result');
  process.exit(1);
}, 120_000);
