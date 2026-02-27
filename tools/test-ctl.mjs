#!/usr/bin/env node
/**
 * Quick test for ctl socket (simulates CLI/TG message path).
 * 
 * Usage: node tools/test-ctl.mjs [agentId] [message]
 */
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const agentId = process.argv[2] || 'sentinella';
const text = process.argv[3] || 'What git branch are you on? One word answer.';
const SOCKET = `/tmp/tgcc/ctl/${agentId}.sock`;

const socket = connect(SOCKET);
const rl = createInterface({ input: socket });

function send(obj) {
  const line = JSON.stringify(obj);
  console.log(`→ ${line}`);
  socket.write(line + '\n');
}

socket.on('connect', () => {
  console.log(`Connected to ${SOCKET}`);
  send({ type: 'message', agent: agentId, text });
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    console.log(`← ${JSON.stringify(msg, null, 2)}`);
    
    if (msg.type === 'result' || msg.type === 'ack') {
      // Got response
      if (msg.type === 'result') {
        console.log('\n=== RESULT ===');
        console.log(msg.text || '(no text)');
        process.exit(0);
      }
    }
  } catch {
    console.log(`← (raw) ${line}`);
  }
});

socket.on('error', (err) => {
  console.error('Socket error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('Timeout');
  process.exit(1);
}, 120_000);
