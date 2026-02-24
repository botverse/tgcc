#!/usr/bin/env node

import { createConnection, type Socket } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CtlRequest, CtlResponse } from './ctl-server.js';
import { loadConfig, agentForRepo, type TgccConfig } from './config.js';

const CTL_DIR = '/tmp/tgcc/ctl';
const CONFIG_PATH = join(homedir(), '.tgcc', 'config.json');

// ── Socket communication ──

function sendRequest(socketPath: string, request: CtlRequest): Promise<CtlResponse> {
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(new Error(`Agent socket not found: ${socketPath}\nIs the TGCC service running?`));
      return;
    }

    const socket: Socket = createConnection(socketPath);
    let buffer = '';

    socket.on('connect', () => {
      socket.write(JSON.stringify(request) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        try {
          const response = JSON.parse(line) as CtlResponse;
          socket.destroy();
          resolve(response);
        } catch (err) {
          socket.destroy();
          reject(new Error(`Invalid response from agent: ${line}`));
        }
      }
    });

    socket.on('error', (err) => {
      reject(new Error(`Cannot connect to agent: ${(err as NodeJS.ErrnoException).message}`));
    });

    // Timeout after 10s
    socket.setTimeout(10_000, () => {
      socket.destroy();
      reject(new Error('Connection timed out'));
    });
  });
}

// ── Agent resolution ──

function resolveAgent(explicitAgent: string | undefined, config: TgccConfig): string {
  if (explicitAgent) {
    if (!config.agents[explicitAgent]) {
      console.error(`Error: Unknown agent "${explicitAgent}"`);
      process.exit(1);
    }
    return explicitAgent;
  }

  // Auto-detect from cwd
  const cwd = process.cwd();
  const agentId = agentForRepo(config, cwd);
  if (!agentId) {
    console.error(`Error: No agent configured for this repo (${cwd})`);
    console.error('Use --agent <name> to specify explicitly');
    process.exit(1);
  }
  return agentId;
}

// ── Commands ──

async function cmdMessage(args: string[]): Promise<void> {
  let agentName: string | undefined;
  let sessionId: string | undefined;
  const textParts: string[] = [];

  // Parse flags
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && i + 1 < args.length) {
      agentName = args[++i];
    } else if (args[i] === '--session' && i + 1 < args.length) {
      sessionId = args[++i];
    } else {
      textParts.push(args[i]);
    }
  }

  const text = textParts.join(' ');
  if (!text) {
    console.error('Error: No message text provided');
    console.error('Usage: tgcc message [--agent <name>] [--session <id>] "your message"');
    process.exit(1);
  }

  const config = loadConfigSafe();
  const agentId = resolveAgent(agentName, config);
  const socketPath = join(CTL_DIR, `${agentId}.sock`);

  const request: CtlRequest = {
    type: 'message',
    text,
    agent: agentId,
    ...(sessionId ? { session: sessionId } : {}),
  };

  const response = await sendRequest(socketPath, request);

  if (response.type === 'error') {
    console.error(`Error: ${response.message}`);
    process.exit(1);
  }

  if (response.type === 'ack') {
    console.log(`Message sent to ${agentId}`);
    console.log(`  Session: ${response.sessionId?.slice(0, 8) ?? 'pending'}`);
    console.log(`  State: ${response.state}`);
  }
}

async function cmdStatus(args: string[]): Promise<void> {
  let agentName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && i + 1 < args.length) {
      agentName = args[++i];
    }
  }

  // If no explicit agent and we can detect from cwd, use it
  const config = loadConfigSafe();

  // Find which sockets exist (running agents)
  const sockets = existsSync(CTL_DIR)
    ? readdirSync(CTL_DIR).filter(f => f.endsWith('.sock'))
    : [];

  if (sockets.length === 0) {
    console.log('No running agents found.');
    return;
  }

  // If specific agent requested, only query that one
  const targetAgents = agentName ? [`${agentName}.sock`] : sockets;

  for (const sockFile of targetAgents) {
    const socketPath = join(CTL_DIR, sockFile);
    if (!existsSync(socketPath)) {
      console.log(`Agent ${sockFile.replace('.sock', '')}: not running`);
      continue;
    }

    try {
      const response = await sendRequest(socketPath, {
        type: 'status',
        agent: sockFile.replace('.sock', ''),
      });

      if (response.type === 'status') {
        for (const agent of response.agents) {
          console.log(`\n${agent.id}:`);
          console.log(`  State: ${agent.state}`);
          console.log(`  Session: ${agent.sessionId?.slice(0, 8) ?? 'none'}`);
          console.log(`  Repo: ${agent.repo}`);
        }
        if (response.sessions.length > 0) {
          console.log('\n  Recent sessions:');
          for (const sess of response.sessions) {
            console.log(`    ${sess.id.slice(0, 8)} — ${sess.messageCount} msgs, $${sess.totalCostUsd.toFixed(4)}`);
          }
        }
      } else if (response.type === 'error') {
        console.error(`  Error: ${response.message}`);
      }
    } catch (err) {
      console.error(`  ${err instanceof Error ? err.message : err}`);
    }
  }
}

function loadConfigSafe(): TgccConfig {
  try {
    return loadConfig();
  } catch (err) {
    console.error(`Error loading config: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// ── Main ──

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'message':
    case 'msg':
      await cmdMessage(args.slice(1));
      break;

    case 'status':
      await cmdStatus(args.slice(1));
      break;

    case 'agent':
      // Placeholder — implemented in Stage 3
      console.error('Agent management commands not yet available.');
      console.error('Usage: tgcc agent add|remove|list|repo');
      process.exit(1);
      break;

    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;

    default:
      if (!command) {
        printHelp();
      } else {
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
      }
  }
}

function printHelp(): void {
  console.log(`tgcc — Telegram ↔ Claude Code CLI

Usage:
  tgcc message [--agent <name>] [--session <id>] "your message"
  tgcc status [--agent <name>]
  tgcc agent add|remove|list|repo
  tgcc help

Commands:
  message   Send a message to a running agent
  status    Show running agents and active sessions
  agent     Manage agent registrations
  help      Show this help message

Options:
  --agent    Specify agent by name (auto-detected from cwd if omitted)
  --session  Resume a specific session by ID`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
