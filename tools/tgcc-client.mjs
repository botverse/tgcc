#!/usr/bin/env node
/**
 * tgcc-client.mjs — OpenClaw helper to attach to a TGCC-managed CC session.
 *
 * Usage:
 *   node tools/tgcc-client.mjs --agent <agentId> --repo <repoPath> [--session <id>] --message <text> [--socket <path>]
 *
 * Connects to the TGCC ctl socket, attaches to a CC session, sends a message,
 * and streams events to stdout until the turn completes.
 *
 * No external dependencies — uses only Node built-ins.
 */

import { connect } from 'node:net';
import { createInterface } from 'node:readline';

// ── Parse args ──

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--agent': args.agent = argv[++i]; break;
      case '--repo': args.repo = argv[++i]; break;
      case '--session': args.session = argv[++i]; break;
      case '--message': args.message = argv[++i]; break;
      case '--socket': args.socket = argv[++i]; break;
      case '--help':
      case '-h':
        console.log('Usage: node tools/tgcc-client.mjs --agent <agentId> --repo <repoPath> [--session <id>] --message <text> [--socket <path>]');
        process.exit(0);
      default:
        console.error(`Unknown argument: ${argv[i]}`);
        process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

if (!args.agent) { console.error('--agent is required'); process.exit(1); }
if (!args.repo) { console.error('--repo is required'); process.exit(1); }
if (!args.message) { console.error('--message is required'); process.exit(1); }

const socketPath = args.socket || `/tmp/tgcc/ctl/${args.agent}.sock`;

// ── State machine ──

let state = 'connecting'; // connecting → attaching → sending → streaming → done

const socket = connect(socketPath);
const rl = createInterface({ input: socket });

socket.on('connect', () => {
  state = 'attaching';
  const attachReq = {
    type: 'attach',
    agent: args.agent,
    repo: args.repo,
  };
  if (args.session) attachReq.session = args.session;
  socket.write(JSON.stringify(attachReq) + '\n');
});

socket.on('error', (err) => {
  console.error(`Socket error: ${err.message}`);
  process.exit(1);
});

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.error(`Invalid JSON from server: ${line}`);
    return;
  }

  switch (state) {
    case 'attaching': {
      if (msg.type === 'error') {
        console.error(`Attach error: ${msg.message}`);
        socket.destroy();
        process.exit(1);
      }
      if (msg.type === 'ready') {
        state = 'sending';
        if (msg.sessionId) {
          process.stderr.write(`Attached to session ${msg.sessionId.slice(0, 8)} (${msg.state})\n`);
        }
        // Send the message
        socket.write(JSON.stringify({ type: 'send', text: args.message }) + '\n');
      }
      break;
    }

    case 'sending': {
      if (msg.type === 'error') {
        console.error(`Send error: ${msg.message}`);
        socket.destroy();
        process.exit(1);
      }
      if (msg.type === 'ack') {
        state = 'streaming';
      }
      break;
    }

    case 'streaming': {
      switch (msg.type) {
        case 'stream_event': {
          const event = msg.event;
          // Print text deltas
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
            process.stdout.write(event.delta.text);
          }
          break;
        }
        case 'result': {
          const event = msg.event;
          // Print newline after streaming text
          process.stdout.write('\n');
          // Print cost summary
          if (event?.total_cost_usd != null) {
            process.stderr.write(`Cost: $${event.total_cost_usd.toFixed(4)}`);
            if (event.usage) {
              process.stderr.write(` | In: ${event.usage.input_tokens ?? 0} Out: ${event.usage.output_tokens ?? 0}`);
            }
            process.stderr.write('\n');
          }
          socket.destroy();
          process.exit(0);
          break;
        }
        case 'compact': {
          process.stderr.write(`Compacted (trigger: ${msg.trigger || 'unknown'})\n`);
          break;
        }
        case 'error': {
          console.error(`Error: ${msg.message}`);
          socket.destroy();
          process.exit(1);
          break;
        }
        case 'disconnected': {
          console.error('Session disconnected by TGCC');
          socket.destroy();
          process.exit(1);
          break;
        }
      }
      break;
    }
  }
});

rl.on('close', () => {
  if (state !== 'done') {
    process.exit(0);
  }
});

// Timeout: 10 minutes
setTimeout(() => {
  console.error('Timeout: no result after 10 minutes');
  socket.destroy();
  process.exit(1);
}, 10 * 60 * 1000);
