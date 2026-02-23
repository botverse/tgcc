import { readFileSync, watchFile, unwatchFile, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

  // Agents
  const agentsRaw = obj.agents;
  if (!agentsRaw || typeof agentsRaw !== 'object') {
    throw new Error('Config must have an "agents" object with at least one agent');
  }

  const agents: Record<string, AgentConfig> = {};
  const seenTokens = new Set<string>();

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
    const defaults: AgentDefaults = {
      model: typeof defaultsRaw.model === 'string' ? defaultsRaw.model : DEFAULT_AGENT_DEFAULTS.model,
      repo: typeof defaultsRaw.repo === 'string' ? defaultsRaw.repo : DEFAULT_AGENT_DEFAULTS.repo,
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

  return { global, agents };
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
