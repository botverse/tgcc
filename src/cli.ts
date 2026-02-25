#!/usr/bin/env node

import { createConnection, type Socket } from 'node:net';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import type { CtlRequest, CtlResponse } from './ctl-server.js';
import { loadConfig, agentForRepo, CONFIG_PATH, updateConfig, isValidRepoName, findRepoOwner, type TgccConfig } from './config.js';

const CTL_DIR = '/tmp/tgcc/ctl';

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

// ── Raw config read/write (preserves structure for agent management) ──

function readRawConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    return { agents: {} };
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
}

function writeRawConfig(raw: Record<string, unknown>): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
}

// ── Agent management commands ──

function cmdAgentAdd(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: tgcc agent add <name> --bot-token <token> [--repo <name-or-path>]');
    process.exit(1);
  }

  let botToken: string | undefined;
  let repo: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--bot-token' || args[i] === '--token') && i + 1 < args.length) {
      botToken = args[++i];
    } else if (args[i] === '--repo' && i + 1 < args.length) {
      repo = args[++i];
    }
  }

  if (!botToken) {
    console.error('Error: --bot-token is required');
    process.exit(1);
  }

  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, unknown>;

  if (agents[name]) {
    console.error(`Error: Agent "${name}" already exists. Remove it first.`);
    process.exit(1);
  }

  const agentEntry: Record<string, unknown> = {
    botToken,
    allowedUsers: ['7016073156'], // default — user can edit config
  };

  if (repo) {
    // Check if it's a registry key or a path
    const repos = (raw.repos ?? {}) as Record<string, string>;
    if (repos[repo]) {
      agentEntry.defaults = { repo };
    } else {
      // It's a direct path — add to repos registry and reference it
      const repoName = repo.split('/').pop() ?? name;
      const absPath = resolve(repo);
      repos[repoName] = absPath;
      raw.repos = repos;
      agentEntry.defaults = { repo: repoName };
    }
  }

  agents[name] = agentEntry;
  raw.agents = agents;
  writeRawConfig(raw);

  console.log(`Agent "${name}" added.`);
  if (repo) console.log(`  Default repo: ${repo}`);
  console.log('Config hot-reload will pick it up automatically.');
}

function cmdAgentRemove(args: string[]): void {
  const name = args[0];
  if (!name) {
    console.error('Usage: tgcc agent remove <name>');
    process.exit(1);
  }

  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, unknown>;

  if (!agents[name]) {
    console.error(`Error: Agent "${name}" not found.`);
    process.exit(1);
  }

  delete agents[name];
  raw.agents = agents;
  writeRawConfig(raw);

  console.log(`Agent "${name}" removed.`);
}

function cmdAgentList(): void {
  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;
  const repos = (raw.repos ?? {}) as Record<string, string>;

  const entries = Object.entries(agents);
  if (entries.length === 0) {
    console.log('No agents configured.');
    return;
  }

  for (const [name, agent] of entries) {
    const defaults = (agent.defaults ?? {}) as Record<string, unknown>;
    const repoKey = defaults.repo as string | undefined;
    const repoPath = repoKey ? (repos[repoKey] ?? repoKey) : 'none (generic)';

    console.log(`${name}:`);
    console.log(`  Token: ${(agent.botToken as string)?.slice(0, 10)}...`);
    console.log(`  Repo: ${repoPath}`);
    console.log(`  Users: ${(agent.allowedUsers as string[])?.join(', ') ?? 'none'}`);
  }
}

function cmdAgentRepo(args: string[]): void {
  const name = args[0];
  const repoArg = args[1];

  if (!name || !repoArg) {
    console.error('Usage: tgcc agent repo <name> <name-or-path>');
    process.exit(1);
  }

  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;

  if (!agents[name]) {
    console.error(`Error: Agent "${name}" not found.`);
    process.exit(1);
  }

  const repos = (raw.repos ?? {}) as Record<string, string>;

  if (repos[repoArg]) {
    // It's a registry key
    const defaults = (agents[name].defaults ?? {}) as Record<string, unknown>;
    defaults.repo = repoArg;
    agents[name].defaults = defaults;
  } else {
    // Direct path — add to registry
    const repoName = repoArg.split('/').pop() ?? name;
    const absPath = resolve(repoArg);
    repos[repoName] = absPath;
    raw.repos = repos;
    const defaults = (agents[name].defaults ?? {}) as Record<string, unknown>;
    defaults.repo = repoName;
    agents[name].defaults = defaults;
  }

  raw.agents = agents;
  writeRawConfig(raw);

  console.log(`Agent "${name}" repo set to "${repoArg}".`);
}

function cmdAgentRename(args: string[]): void {
  const oldName = args[0];
  const newName = args[1];

  if (!oldName || !newName) {
    console.error('Usage: tgcc agent rename <old-name> <new-name>');
    process.exit(1);
  }

  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, unknown>;

  if (!agents[oldName]) {
    console.error(`Error: Agent "${oldName}" not found.`);
    process.exit(1);
  }

  if (agents[newName]) {
    console.error(`Error: Agent "${newName}" already exists.`);
    process.exit(1);
  }

  // Move agent config to new key
  agents[newName] = agents[oldName];
  delete agents[oldName];
  raw.agents = agents;
  writeRawConfig(raw);

  // Update session state file (rename agent key if present)
  const globalRaw = (raw.global ?? {}) as Record<string, string>;
  const stateFile = globalRaw.stateFile ?? join(homedir(), '.tgcc', 'state.json');
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf-8'));
      if (state.agents && state.agents[oldName]) {
        state.agents[newName] = state.agents[oldName];
        delete state.agents[oldName];
        writeFileSync(stateFile, JSON.stringify(state, null, 2));
      }
    } catch (err) {
      console.warn(`Warning: Could not update state file: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(`Agent "${oldName}" renamed to "${newName}".`);
}

function cmdAgent(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case 'add':
      cmdAgentAdd(args.slice(1));
      break;
    case 'remove':
    case 'rm':
      cmdAgentRemove(args.slice(1));
      break;
    case 'rename':
    case 'mv':
      cmdAgentRename(args.slice(1));
      break;
    case 'list':
    case 'ls':
      cmdAgentList();
      break;
    case 'repo':
      cmdAgentRepo(args.slice(1));
      break;
    default:
      console.error('Usage: tgcc agent <add|remove|rename|list|repo>');
      console.error('');
      console.error('  add <name> --bot-token <token> [--repo <path>]');
      console.error('  remove <name>');
      console.error('  rename <old> <new>');
      console.error('  list');
      console.error('  repo <name> <path>');
      process.exit(1);
  }
}

// ── Repo management commands ──

function cmdRepoList(): void {
  const raw = readRawConfig();
  const repos = (raw.repos ?? {}) as Record<string, string>;

  const entries = Object.entries(repos);
  if (entries.length === 0) {
    console.log('No repos registered.');
    return;
  }

  for (const [name, path] of entries) {
    const owner = findRepoOwner(raw, name);
    console.log(`${name}:`);
    console.log(`  Path: ${path}`);
    console.log(`  Agent: ${owner ?? 'unassigned'}`);
  }
}

function cmdRepoAdd(args: string[]): void {
  const { flags, positional } = parseFlags(args);

  let name: string;
  let repoPath: string;

  if (positional.length === 1) {
    // tgcc repo add <path-or-.> [--name=...]
    repoPath = resolve(positional[0]);
    name = flags.name || repoPath.split('/').pop() || 'default';
  } else if (positional.length >= 2) {
    // tgcc repo add <name> <path> (original syntax)
    name = positional[0];
    repoPath = positional[1];
  } else {
    console.error('Usage: tgcc repo add <path> [--name=<name>]');
    console.error('       tgcc repo add <name> <path>');
    process.exit(1);
  }

  if (!isValidRepoName(name)) {
    console.error('Invalid repo name. Use alphanumeric + hyphens only (must start with alphanumeric).');
    process.exit(1);
  }

  if (!existsSync(repoPath)) {
    console.error(`Path not found: ${repoPath}`);
    process.exit(1);
  }

  const raw = readRawConfig();
  const repos = (raw.repos ?? {}) as Record<string, string>;
  if (repos[name]) {
    console.error(`Repo "${name}" already exists.`);
    process.exit(1);
  }

  const absPath = resolve(repoPath);
  updateConfig((cfg) => {
    const r = (cfg.repos ?? {}) as Record<string, string>;
    r[name] = absPath;
    cfg.repos = r;
  });

  console.log(`Repo "${name}" added → ${absPath}`);
}

/** Parse --key=value and --key value flags from args, returning { flags, positional } */
function parseFlags(args: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && args[i].includes('=')) {
      const [key, ...rest] = args[i].slice(2).split('=');
      flags[key] = rest.join('=');
    } else if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('-')) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function cmdRepoRemove(args: string[]): void {
  const { flags, positional } = parseFlags(args);
  const name = flags.name || positional[0];

  if (!name) {
    console.error('Usage: tgcc repo remove <name>');
    console.error('       tgcc repo remove --name=<name>');
    process.exit(1);
  }

  const raw = readRawConfig();
  const repos = (raw.repos ?? {}) as Record<string, string>;
  if (!repos[name]) {
    console.error(`Repo "${name}" not found.`);
    process.exit(1);
  }

  const owner = findRepoOwner(raw, name);
  if (owner) {
    console.error(`Can't remove: repo "${name}" is assigned to agent "${owner}". Use "tgcc repo clear --agent=${owner}" first.`);
    process.exit(1);
  }

  updateConfig((cfg) => {
    const r = (cfg.repos ?? {}) as Record<string, string>;
    delete r[name];
    cfg.repos = r;
  });

  console.log(`Repo "${name}" removed.`);
}

function cmdRepoAssign(args: string[]): void {
  const { flags, positional } = parseFlags(args);
  const agentName = flags.agent || positional[0];
  const repoName = flags.name || positional[1];

  if (!agentName || !repoName) {
    console.error('Usage: tgcc repo assign --agent=<agent> --name=<repo>');
    console.error('       tgcc repo assign <agent> <repo>');
    process.exit(1);
  }

  const raw = readRawConfig();
  const repos = (raw.repos ?? {}) as Record<string, string>;
  const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;

  if (!repos[repoName]) {
    console.error(`Repo "${repoName}" not found in registry.`);
    process.exit(1);
  }

  if (!agents[agentName]) {
    console.error(`Agent "${agentName}" not found.`);
    process.exit(1);
  }

  const existingOwner = findRepoOwner(raw, repoName);
  if (existingOwner && existingOwner !== agentName) {
    console.error(`Repo "${repoName}" is already assigned to agent "${existingOwner}".`);
    process.exit(1);
  }

  updateConfig((cfg) => {
    const a = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>;
    const agentCfg = a[agentName];
    if (agentCfg) {
      const defaults = (agentCfg.defaults ?? {}) as Record<string, unknown>;
      defaults.repo = repoName;
      agentCfg.defaults = defaults;
    }
  });

  console.log(`Repo "${repoName}" assigned to agent "${agentName}".`);
}

function cmdRepoClear(args: string[]): void {
  const { flags, positional } = parseFlags(args);
  const agentName = flags.agent || positional[0];

  if (!agentName) {
    console.error('Usage: tgcc repo clear --agent=<agent>');
    console.error('       tgcc repo clear <agent>');
    process.exit(1);
  }

  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;
  if (!agents[agentName]) {
    console.error(`Agent "${agentName}" not found.`);
    process.exit(1);
  }

  updateConfig((cfg) => {
    const a = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>;
    const agentCfg = a[agentName];
    if (agentCfg) {
      const defaults = (agentCfg.defaults ?? {}) as Record<string, unknown>;
      delete defaults.repo;
      agentCfg.defaults = defaults;
    }
  });

  console.log(`Default repo cleared for agent "${agentName}".`);
}

function cmdRepo(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case 'add':
      cmdRepoAdd(args.slice(1));
      break;
    case 'remove':
    case 'rm':
      cmdRepoRemove(args.slice(1));
      break;
    case 'assign':
      cmdRepoAssign(args.slice(1));
      break;
    case 'clear':
      cmdRepoClear(args.slice(1));
      break;
    case undefined:
    case 'list':
    case 'ls':
      cmdRepoList();
      break;
    default:
      console.error('Usage: tgcc repo [add|remove|assign|clear|list]');
      console.error('');
      console.error('  (no args)                  List all repos');
      console.error('  add <name> <path>          Register a repo');
      console.error('  remove <name>              Remove a repo');
      console.error('  assign <agent> <name>      Set agent default repo');
      console.error('  clear <agent>              Clear agent default repo');
      process.exit(1);
  }
}

// ── Permissions management commands ──

function cmdPermissionsList(): void {
  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;

  const entries = Object.entries(agents);
  if (entries.length === 0) {
    console.log('No agents configured.');
    return;
  }

  for (const [name, agent] of entries) {
    const defaults = (agent.defaults ?? {}) as Record<string, unknown>;
    const mode = (defaults.permissionMode as string) ?? 'dangerously-skip';
    console.log(`${name}: ${mode}`);
  }
}

function cmdPermissionsSet(args: string[]): void {
  const agentName = args[0];
  const mode = args[1];

  if (!agentName || !mode) {
    console.error('Usage: tgcc permissions set <agent> <mode>');
    console.error('Modes: dangerously-skip, acceptEdits, default, plan');
    process.exit(1);
  }

  const validModes = ['dangerously-skip', 'acceptEdits', 'default', 'plan'];
  if (!validModes.includes(mode)) {
    console.error(`Invalid mode: ${mode}`);
    console.error(`Valid modes: ${validModes.join(', ')}`);
    process.exit(1);
  }

  const raw = readRawConfig();
  const agents = (raw.agents ?? {}) as Record<string, Record<string, unknown>>;

  if (!agents[agentName]) {
    console.error(`Agent "${agentName}" not found.`);
    process.exit(1);
  }

  updateConfig((cfg) => {
    const a = (cfg.agents ?? {}) as Record<string, Record<string, unknown>>;
    const agentCfg = a[agentName];
    if (agentCfg) {
      const defaults = (agentCfg.defaults ?? {}) as Record<string, unknown>;
      defaults.permissionMode = mode;
      agentCfg.defaults = defaults;
    }
  });

  console.log(`Permission mode for "${agentName}" set to "${mode}".`);
}

function cmdPermissions(args: string[]): void {
  const subcommand = args[0];

  switch (subcommand) {
    case 'set':
      cmdPermissionsSet(args.slice(1));
      break;
    case undefined:
    case 'list':
    case 'ls':
      cmdPermissionsList();
      break;
    default:
      console.error('Usage: tgcc permissions [set <agent> <mode>]');
      console.error('');
      console.error('  (no args)                  Show permission mode for all agents');
      console.error('  set <agent> <mode>         Set agent default permissionMode');
      console.error('');
      console.error('Modes: dangerously-skip, acceptEdits, default, plan');
      process.exit(1);
  }
}

// ── Main ──

// ── Init command ──

async function prompt(question: string): Promise<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function cmdInit(): Promise<void> {
  const configDir = join(homedir(), '.tgcc');
  const configPath = join(configDir, 'config.json');

  if (existsSync(configPath)) {
    const overwrite = await prompt('Config already exists. Overwrite? (y/N) ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Aborted.');
      return;
    }
  }

  console.log('🤖 TGCC Setup\n');
  console.log('You need a Telegram bot token from @BotFather.\n');

  const agentName = await prompt('Agent name (e.g. my-agent): ') || 'default';
  const botToken = await prompt('Bot token: ');

  if (!botToken) {
    console.error('Bot token is required.');
    process.exit(1);
  }

  const userIdInput = await prompt('Your Telegram user ID (empty = open access): ');
  const allowedUsers = userIdInput ? [userIdInput] : [];

  const repoPath = await prompt('Default repo path (optional, press Enter to skip): ');

  const config: Record<string, unknown> = {
    global: {
      ccBinaryPath: 'claude',
      mediaDir: '/tmp/tgcc/media',
      socketDir: '/tmp/tgcc/sockets',
      logLevel: 'info',
    },
    repos: {} as Record<string, string>,
    agents: {
      [agentName]: {
        botToken,
        allowedUsers,
        defaults: {
          permissionMode: 'bypassPermissions',
        },
      },
    },
  };

  if (repoPath) {
    const repoName = repoPath.split('/').pop() || 'default';
    (config.repos as Record<string, string>)[repoName] = resolve(repoPath);
    (config.agents as Record<string, Record<string, unknown>>)[agentName].defaults = {
      permissionMode: 'bypassPermissions',
      repo: repoName,
    };
  }

  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  console.log(`\n✅ Config written to ${configPath}`);
  console.log(`\nNext steps:`);
  console.log(`  tgcc run         Run in foreground to test`);
  console.log(`  tgcc install     Install as a service`);
  console.log(`\nSend /start to your bot on Telegram to begin.`);
}

// ── Start / Service commands ──

async function ensureConfig(): Promise<void> {
  const configPath = join(homedir(), '.tgcc', 'config.json');
  if (!existsSync(configPath)) {
    console.log('No config found. Let\'s set one up.\n');
    await cmdInit();
  }
}

function checkClaudeCode(): void {
  // Check if claude binary exists
  try {
    execSync('which claude', { stdio: 'ignore' });
  } catch {
    console.error('❌ Claude Code CLI not found.\n');
    console.error('Install it:');
    console.error('  npm install -g @anthropic-ai/claude-code\n');
    console.error('Then authenticate:');
    console.error('  claude login');
    process.exit(1);
  }

  // Check if logged in
  try {
    const output = execSync('claude --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (!output) throw new Error('no output');
  } catch {
    console.error('❌ Claude Code CLI found but not responding.\n');
    console.error('Try:');
    console.error('  claude --version');
    console.error('  claude login');
    process.exit(1);
  }
}

async function cmdStart(): Promise<void> {
  await ensureConfig();
  checkClaudeCode();
  const { main: serviceMain } = await import('./service.js');
  await serviceMain();
}

const SYSTEMD_UNIT = `[Unit]
Description=TGCC — Telegram ↔ Claude Code bridge
After=network.target

[Service]
Type=simple
ExecStart=TGCC_BIN
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=PATH_VAL

[Install]
WantedBy=default.target
`;

const LAUNCHD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.tgcc.service</string>
  <key>ProgramArguments</key>
  <array>
    <string>TGCC_BIN</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>LOG_DIR/tgcc.log</string>
  <key>StandardErrorPath</key>
  <string>LOG_DIR/tgcc.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>PATH_VAL</string>
  </dict>
</dict>
</plist>
`;

function detectPlatform(): 'linux' | 'mac' {
  return process.platform === 'darwin' ? 'mac' : 'linux';
}

function findTgccBin(): string {
  try {
    return execSync('which tgcc', { encoding: 'utf-8' }).trim();
  } catch {
    return join(dirname(process.argv[1]), 'tgcc');
  }
}

async function cmdInstall(): Promise<void> {
  await ensureConfig();
  const platform = detectPlatform();
  const tgccBin = findTgccBin();

  if (platform === 'mac') {
    const plistDir = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = join(plistDir, 'io.tgcc.service.plist');
    const logDir = join(homedir(), '.tgcc', 'logs');

    mkdirSync(plistDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    const content = LAUNCHD_PLIST
      .replace(/TGCC_BIN/g, tgccBin)
      .replace(/LOG_DIR/g, logDir)
      .replace(/PATH_VAL/g, process.env.PATH || '/usr/local/bin:/usr/bin:/bin');

    writeFileSync(plistPath, content);
    execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, { stdio: 'ignore' });
    console.log(`✅ Service installed and started.`);
    console.log(`\n  tgcc stop        Stop the service`);
    console.log(`  tgcc restart     Restart the service`);
    console.log(`  tgcc logs        Tail logs`);
    console.log(`  tgcc uninstall   Remove the service`);
  } else {
    const unitDir = join(homedir(), '.config', 'systemd', 'user');
    const unitPath = join(unitDir, 'tgcc.service');

    mkdirSync(unitDir, { recursive: true });

    const content = SYSTEMD_UNIT
      .replace(/TGCC_BIN/g, `${tgccBin} run`)
      .replace(/PATH_VAL/g, process.env.PATH || '/usr/local/bin:/usr/bin:/bin');
    writeFileSync(unitPath, content);
    execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
    execSync('systemctl --user enable --now tgcc', { stdio: 'ignore' });
    console.log(`✅ Service installed and started.`);
    console.log(`\n  tgcc stop        Stop the service`);
    console.log(`  tgcc restart     Restart the service`);
    console.log(`  tgcc logs        Tail logs`);
    console.log(`  tgcc uninstall   Remove the service`);
  }
}

function cmdUninstall(): void {
  const platform = detectPlatform();

  if (platform === 'mac') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'io.tgcc.service.plist');
    if (existsSync(plistPath)) {
      try {
        execSync(`launchctl unload ${plistPath}`, { stdio: 'ignore' });
      } catch { /* might not be loaded */ }
      unlinkSync(plistPath);
      console.log(`✅ LaunchAgent removed: ${plistPath}`);
    } else {
      console.log('No LaunchAgent found. Nothing to uninstall.');
    }
  } else {
    const unitPath = join(homedir(), '.config', 'systemd', 'user', 'tgcc.service');
    if (existsSync(unitPath)) {
      try {
        execSync('systemctl --user disable --now tgcc', { stdio: 'ignore' });
      } catch { /* might not be active */ }
      unlinkSync(unitPath);
      execSync('systemctl --user daemon-reload', { stdio: 'ignore' });
      console.log(`✅ Systemd user service removed: ${unitPath}`);
    } else {
      console.log('No systemd user service found. Nothing to uninstall.');
    }
  }
}

function cmdServiceCtl(action: 'start' | 'stop' | 'restart'): void {
  const platform = detectPlatform();

  if (platform === 'mac') {
    const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'io.tgcc.service.plist');
    if (!existsSync(plistPath)) {
      console.error('Service not installed. Run: tgcc install');
      process.exit(1);
    }
    if (action === 'stop') {
      execSync(`launchctl bootout gui/$(id -u) ${plistPath}`, { stdio: 'inherit' });
    } else if (action === 'start') {
      execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, { stdio: 'inherit' });
    } else {
      try { execSync(`launchctl bootout gui/$(id -u) ${plistPath}`, { stdio: 'ignore' }); } catch { /* ok */ }
      execSync(`launchctl bootstrap gui/$(id -u) ${plistPath}`, { stdio: 'inherit' });
    }
  } else {
    const unitPath = join(homedir(), '.config', 'systemd', 'user', 'tgcc.service');
    if (!existsSync(unitPath)) {
      console.error('Service not installed. Run: tgcc install');
      process.exit(1);
    }
    execSync(`systemctl --user ${action} tgcc`, { stdio: 'inherit' });
  }

  const labels = { start: 'started', stop: 'stopped', restart: 'restarted' };
  console.log(`✅ Service ${labels[action]}.`);
}

function cmdLogs(): void {
  const platform = detectPlatform();

  if (platform === 'mac') {
    const logPath = join(homedir(), '.tgcc', 'logs', 'tgcc.log');
    if (existsSync(logPath)) {
      execSync(`tail -f ${logPath}`, { stdio: 'inherit' });
    } else {
      console.error(`No log file found at ${logPath}`);
      process.exit(1);
    }
  } else {
    execSync('journalctl --user -u tgcc -f --no-pager', { stdio: 'inherit' });
  }
}

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
      cmdAgent(args.slice(1));
      break;

    case 'repo':
      cmdRepo(args.slice(1));
      break;

    case 'permissions':
      cmdPermissions(args.slice(1));
      break;

    case 'init':
      await cmdInit();
      break;

    case 'run':
      await cmdStart();
      break;

    case 'start':
      cmdServiceCtl('start');
      break;

    case 'install':
      await cmdInstall();
      break;

    case 'uninstall':
      cmdUninstall();
      break;

    case 'stop':
      cmdServiceCtl('stop');
      break;

    case 'restart':
      cmdServiceCtl('restart');
      break;

    case 'logs':
      cmdLogs();
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

Setup:
  tgcc init                 Create config interactively

Service:
  tgcc install              Install & start as a user service (systemd/launchd)
  tgcc start                Start the service
  tgcc stop                 Stop the service
  tgcc restart              Restart the service
  tgcc uninstall            Remove the service
  tgcc logs                 Tail service logs
  tgcc run                  Run in the foreground (no service)

Commands:
  tgcc status [--agent]     Show running agents and active sessions
  tgcc message [--agent] "text"  Send a message to a running agent
  tgcc agent <subcommand>   Manage agent registrations
  tgcc repo <subcommand>    Manage repo registry
  tgcc permissions          View/set agent permission modes
  tgcc help                 Show this help message`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
