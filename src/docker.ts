/**
 * Docker container lifecycle management for shared agents.
 *
 * Each docker-mode agent gets a persistent container (named `tgcc-<agentId>`)
 * running the tgcc-relay daemon. The container is started on first use and
 * kept alive — the relay inside manages CC process spawning/killing.
 *
 * CC authenticates via subscription (OAuth tokens in ~/.claude/.credentials.json),
 * NOT via ANTHROPIC_API_KEY. We sync auth files from the host into the
 * agent's isolated config dir so CC inside the container can authenticate.
 */

import { execSync, type ExecSyncOptions } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { ShareConfig } from './config.js';

const IMAGE = 'tgcc/sandbox';
const CONTAINER_PREFIX = 'tgcc-';

/** Files to sync from host ~/.claude/ into the isolated config dir for auth. */
const AUTH_FILES = ['.credentials.json'];

export interface DockerContainerOpts {
  agentId: string;
  repo: string;            // absolute path to the project on the host
  shareConfig: ShareConfig;
  socketDir: string;        // host dir for relay sockets (e.g. /tmp/tgcc/sockets)
  claudeConfigDir: string;  // host-side isolated .claude/ dir
  tgccDistDir: string;      // path to TGCC's compiled dist/ (for MCP server)
}

const EXEC_OPTS: ExecSyncOptions = { encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' };

function containerName(agentId: string): string {
  return `${CONTAINER_PREFIX}${agentId}`;
}

/** Check if a container exists and is running. */
function isContainerRunning(name: string): boolean {
  try {
    const state = execSync(
      `docker inspect --format='{{.State.Running}}' ${name}`,
      EXEC_OPTS,
    ) as string;
    return state.trim() === 'true';
  } catch {
    return false;
  }
}

/** Check if a container exists (running or stopped). */
function containerExists(name: string): boolean {
  try {
    execSync(`docker inspect --format='{{.State.Status}}' ${name}`, EXEC_OPTS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync CC auth files from host ~/.claude/ into the isolated config dir.
 * This allows CC inside the container to use the subscription (OAuth tokens)
 * without exposing an API key.
 */
export function syncAuthFiles(claudeConfigDir: string): void {
  const hostClaudeDir = join(homedir(), '.claude');
  mkdirSync(claudeConfigDir, { recursive: true });

  for (const file of AUTH_FILES) {
    const src = join(hostClaudeDir, file);
    const dst = join(claudeConfigDir, file);
    if (existsSync(src)) {
      copyFileSync(src, dst);
    }
  }
}

/**
 * Generate a CLAUDE.md for container agents that combines the repo's existing
 * CLAUDE.md with container-specific instructions.
 * Runs on every spawn so it always picks up the latest repo CLAUDE.md.
 */
export function generateContainerClaudeMd(
  repoPath: string,
  claudeConfigDir: string,
  extraInstructions?: string,
): void {
  mkdirSync(claudeConfigDir, { recursive: true });

  // Read repo's existing CLAUDE.md if present
  let repoClaudeMd = '';
  const repoClaudeMdPath = join(repoPath, 'CLAUDE.md');
  if (existsSync(repoClaudeMdPath)) {
    repoClaudeMd = readFileSync(repoClaudeMdPath, 'utf-8');
  }

  const containerSection = `
# Container Environment (TGCC-managed)

You are running inside a Docker container managed by TGCC (Telegram ↔ Claude Code bridge).

## Paths
- **Working directory**: \`/home/project/repo\` (bind-mounted from host)
- **Home / config**: \`/home/project\`
- File changes in \`/home/project/repo\` persist on the host

## What runs locally (inside the container)
- All Bash commands (ls, cat, grep, npm, node, etc.) run inside the container — this is normal
- Git operations (status, diff, log, commit, branch) work locally
- File reads, writes, and edits happen locally on the mounted repo
- **Do NOT use \`supervisor_exec\` for commands that work inside the container**

## Host operations
- **Do NOT use \`supervisor_exec\` directly** for complex host tasks
- Use \`tgcc_send\` to delegate host-side work to another agent (see Additional Instructions for which agent)
- \`supervisor_exec\` is only for simple, one-off commands like \`git push\`

## Git
- Git works inside the container — commits are safe
- **Never push from container** — use \`supervisor_exec\` to push from the host

## Communication
- Use \`tgcc_send\` to message other agents (host agent, supervisor, etc.)
- Use \`notify_supervisor\` to ask the supervisor for help or report blockers
- Use \`supervisor_notify\` to send push notifications to the admin
- Use \`tgcc_agents\` to discover available agents
`.trim();

  const parts = [repoClaudeMd, containerSection];
  if (extraInstructions) {
    parts.push(`\n# Additional Instructions\n\n${extraInstructions}`);
  }

  const content = parts.filter(Boolean).join('\n\n');
  writeFileSync(join(claudeConfigDir, 'CLAUDE.md'), content + '\n');
}

/**
 * Ensure the docker container for this agent is running.
 * Returns the relay socket path on the host.
 */
export function ensureContainer(opts: DockerContainerOpts): string {
  const name = containerName(opts.agentId);
  const socketPath = join(opts.socketDir, `${opts.agentId}.sock`);

  // Already running? Just return.
  if (isContainerRunning(name)) {
    return socketPath;
  }

  // Exists but stopped? Start it.
  if (containerExists(name)) {
    execSync(`docker start ${name}`, EXEC_OPTS);
    return socketPath;
  }

  // Create and start a new container
  const args: string[] = [
    'docker', 'run', '-d',
    '--name', name,
    '--restart', 'unless-stopped',
  ];

  // Mount project repo
  args.push('-v', `${opts.repo}:/home/project/repo`);

  // Mount relay socket dir (shared between host TGCC and container relay)
  args.push('-v', `${opts.socketDir}:/run/tgcc`);

  // Mount isolated .claude/ config dir (contains sessions, MCP config, CLAUDE.md)
  args.push('-v', `${opts.claudeConfigDir}:/home/project/.claude`);

  // Mount host credentials directly (read-only) — always fresh, no sync needed
  const hostCredentials = join(homedir(), '.claude', '.credentials.json');
  if (existsSync(hostCredentials)) {
    args.push('-v', `${hostCredentials}:/home/project/.claude/.credentials.json:ro`);
  }

  // Mount TGCC dist/ for MCP server (CC spawns the MCP server as a subprocess)
  args.push('-v', `${opts.tgccDistDir}:/opt/tgcc:ro`);

  // Set CLAUDE_CONFIG_DIR inside container
  args.push('-e', 'CLAUDE_CONFIG_DIR=/home/project/.claude');

  // Set working directory to the mounted repo
  args.push('-w', '/home/project/repo');

  // Docker config: networks
  const docker = opts.shareConfig.docker;
  if (docker?.networks) {
    // docker run only supports one --network; we'll connect additional ones after creation
    if (docker.networks.length > 0) {
      args.push('--network', docker.networks[0]);
    }
  }

  // Docker config: env vars (project-specific, e.g. SUPABASE_URL)
  if (docker?.env) {
    for (const [key, val] of Object.entries(docker.env)) {
      // Resolve ${VAR} references from host environment
      const resolved = val.replace(/\$\{(\w+)\}/g, (_, varName: string) => process.env[varName] ?? '');
      args.push('-e', `${key}=${resolved}`);
    }
  }

  // Docker config: env_file
  if (docker?.env_file) {
    args.push('--env-file', docker.env_file);
  }

  // Docker config: extra volumes
  if (docker?.volumes) {
    for (const [hostPath, containerPath] of Object.entries(docker.volumes)) {
      args.push('-v', `${hostPath}:${containerPath}`);
    }
  }

  // Docker config: resource limits
  if (docker?.resources?.cpus) {
    args.push('--cpus', String(docker.resources.cpus));
  }
  if (docker?.resources?.memory) {
    args.push('--memory', docker.resources.memory);
  }

  // Docker config: port mappings (bind to localhost only — external access via Tailscale)
  if (docker?.ports) {
    for (const [containerPort, hostPort] of Object.entries(docker.ports)) {
      args.push('-p', `127.0.0.1:${hostPort}:${containerPort}`);
    }
  }

  // Set the relay socket path inside the container
  args.push('-e', `TGCC_RELAY_SOCKET=/run/tgcc/${opts.agentId}.sock`);

  // Image
  args.push(IMAGE);

  const cmd = args.join(' ');
  execSync(cmd, { ...EXEC_OPTS, timeout: 60_000 });

  // Connect additional networks (docker run only supports one --network)
  if (docker?.networks && docker.networks.length > 1) {
    for (let i = 1; i < docker.networks.length; i++) {
      try {
        execSync(`docker network connect ${docker.networks[i]} ${name}`, EXEC_OPTS);
      } catch {
        // Non-fatal — might already be connected
      }
    }
  }

  // Ensure internet access: connect to default bridge if not already on it
  if (docker?.networks && !docker.networks.includes('bridge')) {
    try {
      execSync(`docker network connect bridge ${name}`, EXEC_OPTS);
    } catch {
      // Non-fatal — might already be connected
    }
  }

  return socketPath;
}

/**
 * Generate MCP config for a container-mode agent.
 * Paths point to container-local locations (mounted volumes).
 * The TGCC MCP server is at /opt/tgcc/dist/mcp-server.js inside the container.
 *
 * @param additionalServers - Extra MCP servers to include (e.g. patchright)
 */
export function generateContainerMcpConfig(
  agentId: string,
  userId: string,
  mcpConfigDir: string,
  additionalServers?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>,
): string {
  const config: Record<string, unknown> = {
    mcpServers: {
      tgcc: {
        command: 'node',
        args: ['/opt/tgcc/dist/mcp-server.js'],
        env: {
          TGCC_AGENT_ID: agentId,
          TGCC_USER_ID: userId,
          // Socket path inside the container (mounted from host)
          TGCC_SOCKET: `/run/tgcc/${agentId}-${userId}.sock`,
        },
      },
      ...additionalServers,
    },
  };

  mkdirSync(mcpConfigDir, { recursive: true });
  const configPath = join(mcpConfigDir, `mcp-${agentId}-${userId}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

/** Stop and remove the container for an agent. */
export function destroyContainer(agentId: string): void {
  const name = containerName(agentId);
  try {
    execSync(`docker rm -f ${name}`, EXEC_OPTS);
  } catch {
    // Already gone
  }
}

/** Get container status for an agent. Returns null if not found. */
export function getContainerStatus(agentId: string): { running: boolean; status: string } | null {
  const name = containerName(agentId);
  try {
    const status = (execSync(
      `docker inspect --format='{{.State.Status}}' ${name}`,
      EXEC_OPTS,
    ) as string).trim();
    return { running: status === 'running', status };
  } catch {
    return null;
  }
}
