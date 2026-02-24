import { readFileSync, writeFileSync, watchFile, unwatchFile, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';
import pino from 'pino';

// ── Types ──

export interface GlobalConfig {
  ccBinaryPath: string;
  mediaDir: string;
  socketDir: string;
  logLevel: string;
  stateFile: string;
}

export interface AgentDefaults {
  model: string;
  repo: string;
  maxTurns: number;
  idleTimeoutMs: number;
  hangTimeoutMs: number;
  permissionMode: 'dangerously-skip' | 'default' | 'allowlist';
}

export interface AgentUserOverride {
  model?: string;
  repo?: string;
}

export interface AgentConfig {
  botToken: string;
  allowedUsers: string[];
  defaults: AgentDefaults;
  users?: Record<string, AgentUserOverride>;
}

export interface TgccConfig {
  global: GlobalConfig;
  repos: Record<string, string>;       // name → absolute path
  agents: Record<string, AgentConfig>;
}

// ── Defaults ──

const DEFAULT_GLOBAL: GlobalConfig = {
  ccBinaryPath: 'claude',
  mediaDir: '/tmp/tgcc/media',
  socketDir: '/tmp/tgcc/sockets',
  logLevel: 'info',
  stateFile: join(homedir(), '.tgcc', 'state.json'),
};

const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  model: 'claude-sonnet-4-20250514',
  repo: homedir(),
  maxTurns: 50,
  idleTimeoutMs: 300_000,
  hangTimeoutMs: 300_000,
  permissionMode: 'dangerously-skip',
};

// ── Validation ──

export function validateConfig(raw: unknown): TgccConfig {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Config must be a JSON object');
  }

  const obj = raw as Record<string, unknown>;

  // Global config with defaults
  const globalRaw = (obj.global ?? {}) as Record<string, unknown>;
  const global: GlobalConfig = {
    ccBinaryPath: typeof globalRaw.ccBinaryPath === 'string' ? globalRaw.ccBinaryPath : DEFAULT_GLOBAL.ccBinaryPath,
    mediaDir: typeof globalRaw.mediaDir === 'string' ? globalRaw.mediaDir : DEFAULT_GLOBAL.mediaDir,
    socketDir: typeof globalRaw.socketDir === 'string' ? globalRaw.socketDir : DEFAULT_GLOBAL.socketDir,
    logLevel: typeof globalRaw.logLevel === 'string' ? globalRaw.logLevel : DEFAULT_GLOBAL.logLevel,
    stateFile: typeof globalRaw.stateFile === 'string' ? globalRaw.stateFile : DEFAULT_GLOBAL.stateFile,
  };

  // Repos registry
  const repos: Record<string, string> = {};
  const reposRaw = obj.repos;
  if (reposRaw && typeof reposRaw === 'object') {
    for (const [name, path] of Object.entries(reposRaw as Record<string, unknown>)) {
      if (typeof path === 'string') {
        repos[name] = path;
      }
    }
  }

  // Agents
  const agentsRaw = obj.agents;
  if (!agentsRaw || typeof agentsRaw !== 'object') {
    throw new Error('Config must have an "agents" object with at least one agent');
  }

  const agents: Record<string, AgentConfig> = {};
  const seenTokens = new Set<string>();
  const repoOwners = new Map<string, string>(); // repo key → agentId (exclusivity)

  for (const [agentId, agentRaw] of Object.entries(agentsRaw as Record<string, unknown>)) {
    if (!agentRaw || typeof agentRaw !== 'object') {
      throw new Error(`Agent "${agentId}" must be an object`);
    }
    const a = agentRaw as Record<string, unknown>;

    if (typeof a.botToken !== 'string' || !a.botToken) {
      throw new Error(`Agent "${agentId}" must have a "botToken" string`);
    }

    if (seenTokens.has(a.botToken)) {
      throw new Error(`Duplicate botToken in agent "${agentId}" — each agent must have a unique token`);
    }
    seenTokens.add(a.botToken);

    if (!Array.isArray(a.allowedUsers) || a.allowedUsers.length === 0) {
      throw new Error(`Agent "${agentId}" must have a non-empty "allowedUsers" array`);
    }

    const defaultsRaw = (a.defaults ?? {}) as Record<string, unknown>;

    // Resolve defaults.repo: if it's a key in the repos map, resolve to the path
    let resolvedRepo = DEFAULT_AGENT_DEFAULTS.repo;
    if (typeof defaultsRaw.repo === 'string') {
      const repoKey = defaultsRaw.repo;
      if (repos[repoKey]) {
        // It's a reference to the repos registry
        resolvedRepo = repos[repoKey];

        // Validate exclusivity: one agent per repo key
        if (repoOwners.has(repoKey)) {
          throw new Error(`Repo "${repoKey}" is already assigned to agent "${repoOwners.get(repoKey)}" — each repo can only be assigned to one agent`);
        }
        repoOwners.set(repoKey, agentId);
      } else {
        // Treat as a direct path (backwards compat)
        resolvedRepo = repoKey;
      }
    }

    const defaults: AgentDefaults = {
      model: typeof defaultsRaw.model === 'string' ? defaultsRaw.model : DEFAULT_AGENT_DEFAULTS.model,
      repo: resolvedRepo,
      maxTurns: typeof defaultsRaw.maxTurns === 'number' ? defaultsRaw.maxTurns : DEFAULT_AGENT_DEFAULTS.maxTurns,
      idleTimeoutMs: typeof defaultsRaw.idleTimeoutMs === 'number' ? defaultsRaw.idleTimeoutMs : DEFAULT_AGENT_DEFAULTS.idleTimeoutMs,
      hangTimeoutMs: typeof defaultsRaw.hangTimeoutMs === 'number' ? defaultsRaw.hangTimeoutMs : DEFAULT_AGENT_DEFAULTS.hangTimeoutMs,
      permissionMode: ['dangerously-skip', 'default', 'allowlist'].includes(defaultsRaw.permissionMode as string)
        ? (defaultsRaw.permissionMode as AgentDefaults['permissionMode'])
        : DEFAULT_AGENT_DEFAULTS.permissionMode,
    };

    const users: Record<string, AgentUserOverride> = {};
    if (a.users && typeof a.users === 'object') {
      for (const [userId, uRaw] of Object.entries(a.users as Record<string, unknown>)) {
        if (uRaw && typeof uRaw === 'object') {
          const u = uRaw as Record<string, unknown>;
          users[userId] = {
            ...(typeof u.model === 'string' ? { model: u.model } : {}),
            ...(typeof u.repo === 'string' ? { repo: u.repo } : {}),
          };
        }
      }
    }

    agents[agentId] = {
      botToken: a.botToken,
      allowedUsers: a.allowedUsers.map(String),
      defaults,
      users,
    };
  }

  if (Object.keys(agents).length === 0) {
    throw new Error('Config must have at least one agent');
  }

  return { global, repos, agents };
}

// ── Resolved per-user config ──

export interface ResolvedUserConfig {
  model: string;
  repo: string;
  maxTurns: number;
  idleTimeoutMs: number;
  hangTimeoutMs: number;
  permissionMode: AgentDefaults['permissionMode'];
}

export function resolveUserConfig(agent: AgentConfig, userId: string): ResolvedUserConfig {
  const userOverride = agent.users?.[userId] ?? {};
  return {
    model: userOverride.model ?? agent.defaults.model,
    repo: userOverride.repo ?? agent.defaults.repo,
    maxTurns: agent.defaults.maxTurns,
    idleTimeoutMs: agent.defaults.idleTimeoutMs,
    hangTimeoutMs: agent.defaults.hangTimeoutMs,
    permissionMode: agent.defaults.permissionMode,
  };
}

// ── Repo registry helpers ──

/** Resolve a repo name or path: if it matches a key in the repos map, return the path; otherwise return as-is. */
export function resolveRepoPath(repos: Record<string, string>, nameOrPath: string): string {
  return repos[nameOrPath] ?? nameOrPath;
}

/** Find which agent owns a given repo path (by matching defaults.repo). Returns agentId or null. */
export function agentForRepo(config: TgccConfig, repoPath: string): string | null {
  for (const [agentId, agent] of Object.entries(config.agents)) {
    if (agent.defaults.repo === repoPath) return agentId;
  }
  // Also check if repoPath is inside an agent's repo
  for (const [agentId, agent] of Object.entries(config.agents)) {
    const agentRepo = agent.defaults.repo;
    if (agentRepo !== DEFAULT_AGENT_DEFAULTS.repo && repoPath.startsWith(agentRepo + '/')) {
      return agentId;
    }
  }
  return null;
}

// ── Repo name validation ──

const REPO_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME_RE.test(name);
}

/** Find which agent "owns" a repo key (has it as defaults.repo in the raw config). */
export function findRepoOwner(rawConfig: Record<string, unknown>, repoKey: string): string | null {
  const agents = (rawConfig.agents ?? {}) as Record<string, Record<string, unknown>>;
  for (const [agentId, agent] of Object.entries(agents)) {
    const defaults = (agent.defaults ?? {}) as Record<string, unknown>;
    if (defaults.repo === repoKey) return agentId;
  }
  return null;
}

// ── Config mutation helper ──

/**
 * Read config, apply a mutator, write back.
 * The file watcher handles hot-reload automatically.
 */
export function updateConfig(mutator: (config: Record<string, unknown>) => void): void {
  const dir = dirname(CONFIG_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let raw: Record<string, unknown> = {};
  if (existsSync(CONFIG_PATH)) {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  }

  mutator(raw);

  writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2) + '\n');
}

// ── Config loading and watching ──

export const CONFIG_PATH = join(homedir(), '.tgcc', 'config.json');

export function loadConfig(configPath: string = CONFIG_PATH): TgccConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
  return validateConfig(raw);
}

export function ensureDirectories(config: TgccConfig): void {
  const dirs = [
    config.global.mediaDir,
    config.global.socketDir,
    join(homedir(), '.tgcc'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

// ── Config diff for hot reload ──

export interface ConfigDiff {
  added: string[];    // new agent IDs
  removed: string[];  // removed agent IDs
  changed: string[];  // agents with changed config
}

export function diffConfigs(oldConfig: TgccConfig, newConfig: TgccConfig): ConfigDiff {
  // Note: repos changes are detected implicitly via agent config changes
  // since repo keys are resolved to paths during validation
  const oldIds = new Set(Object.keys(oldConfig.agents));
  const newIds = new Set(Object.keys(newConfig.agents));

  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));
  const changed: string[] = [];

  for (const id of oldIds) {
    if (newIds.has(id)) {
      if (JSON.stringify(oldConfig.agents[id]) !== JSON.stringify(newConfig.agents[id])) {
        changed.push(id);
      }
    }
  }

  return { added, removed, changed };
}

// ── Config watcher with debounce ──

export type ConfigChangeHandler = (newConfig: TgccConfig, diff: ConfigDiff) => void;

export class ConfigWatcher extends EventEmitter {
  private currentConfig: TgccConfig;
  private configPath: string;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private logger: pino.Logger;

  constructor(config: TgccConfig, configPath: string = CONFIG_PATH, logger?: pino.Logger) {
    super();
    this.currentConfig = config;
    this.configPath = configPath;
    this.logger = logger ?? pino({ level: 'info' });
  }

  get config(): TgccConfig {
    return this.currentConfig;
  }

  start(): void {
    watchFile(this.configPath, { interval: 1000 }, () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.reload(), 1000);
    });
    this.logger.info({ path: this.configPath }, 'Watching config file');
  }

  stop(): void {
    unwatchFile(this.configPath);
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  reload(): void {
    try {
      const newConfig = loadConfig(this.configPath);
      const diff = diffConfigs(this.currentConfig, newConfig);

      if (diff.added.length || diff.removed.length || diff.changed.length) {
        this.logger.info({ diff }, 'Config changed');
        this.currentConfig = newConfig;
        this.emit('change', newConfig, diff);
      }
    } catch (err) {
      this.logger.error({ err }, 'Config reload failed — keeping current config');
      this.emit('error', err);
    }
  }
}
