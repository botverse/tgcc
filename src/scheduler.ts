import { Cron } from 'croner';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import pino from 'pino';
import type { HeartbeatConfig, CronJobConfig, HeartbeatIntervalMins } from './config.js';

// ── Types ──

export interface SchedulerSendFn {
  (agentId: string, text: string): void;
}

export interface SchedulerSpawnFn {
  (job: CronJobConfig): void;
}

export interface SchedulerAnnounceFn {
  (agentId: string, text: string): void;
}

/** Persisted dynamic job — extends CronJobConfig with runtime metadata. */
export interface DynamicCronJob extends CronJobConfig {
  createdAt: string;   // ISO-8601
  runCount: number;
  lastRunAt: string | null;
}

/** Info returned by listJobs for display purposes. */
export interface CronJobInfo {
  id: string;
  name?: string;
  schedule: string;
  tz?: string;
  agentId: string;
  message: string;
  session: string;
  announce?: boolean;
  deleteAfterRun?: boolean;
  source: 'static' | 'dynamic';
  nextRun: Date | null;
  runCount?: number;
  lastRunAt?: string | null;
  createdAt?: string;
}

// ── Helpers ──

const INTERVAL_TO_CRON: Record<HeartbeatIntervalMins, string> = {
  5:  '*/5 * * * *',
  10: '*/10 * * * *',
  15: '*/15 * * * *',
  30: '*/30 * * * *',
  60: '0 * * * *',
};

/** Default path for persisting dynamic cron jobs. */
const DYNAMIC_JOBS_PATH = join(homedir(), '.config', 'tgcc', 'cron-jobs.json');

/**
 * Parse a relative time string like "20m", "4h", "1d" into milliseconds.
 * Returns null if the string is not a valid relative time.
 */
export function parseRelativeTime(input: string): number | null {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60_000;
    case 'h': return value * 3_600_000;
    case 'd': return value * 86_400_000;
    default: return null;
  }
}

/**
 * Convert a relative time string (e.g. "20m") or absolute ISO datetime
 * into a one-shot cron expression that fires once.
 * Returns { schedule, tz } or null if parsing fails.
 */
export function computeOneShotSchedule(atValue: string): { schedule: string; tz: string } | null {
  // Try relative time first
  const relMs = parseRelativeTime(atValue);
  if (relMs !== null) {
    const target = new Date(Date.now() + relMs);
    return {
      schedule: `${target.getUTCMinutes()} ${target.getUTCHours()} ${target.getUTCDate()} ${target.getUTCMonth() + 1} *`,
      tz: 'UTC',
    };
  }

  // Try absolute ISO datetime
  const parsed = new Date(atValue);
  if (!isNaN(parsed.getTime())) {
    return {
      schedule: `${parsed.getUTCMinutes()} ${parsed.getUTCHours()} ${parsed.getUTCDate()} ${parsed.getUTCMonth() + 1} *`,
      tz: 'UTC',
    };
  }

  return null;
}

/**
 * Parse an --every interval string like "4h", "30m" into a cron expression.
 * Returns null if parsing fails.
 */
export function parseEveryToCron(every: string): string | null {
  const match = every.match(/^(\d+)\s*(m|h)$/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();

  if (unit === 'm') {
    if (value < 1 || value > 59) return null;
    return `*/${value} * * * *`;
  }
  if (unit === 'h') {
    if (value < 1 || value > 23) return null;
    return `0 */${value} * * *`;
  }
  return null;
}

// ── Scheduler ──

export class Scheduler {
  private readonly logger: pino.Logger;
  /** agentId → running Cron instance */
  private heartbeats = new Map<string, Cron>();
  /** jobId → running Cron instance */
  private cronJobs = new Map<string, Cron>();
  /** jobId → CronJobConfig for all active jobs (static + dynamic) */
  private jobConfigs = new Map<string, CronJobConfig>();
  /** jobId → DynamicCronJob for persisted dynamic jobs only */
  private dynamicJobs = new Map<string, DynamicCronJob>();
  /** Set of job IDs that came from static config (not persisted) */
  private staticJobIds = new Set<string>();
  /** Announce callback — set by bridge to post TG messages */
  private announceFn: SchedulerAnnounceFn | null = null;

  constructor(logger: pino.Logger) {
    this.logger = logger.child({ component: 'scheduler' });
  }

  /** Set the announce callback for TG status messages on cron fire. */
  setAnnounceFn(fn: SchedulerAnnounceFn): void {
    this.announceFn = fn;
  }

  // ── Heartbeat ──

  startHeartbeat(
    agentId: string,
    config: HeartbeatConfig,
    isIdle: () => boolean,
    send: SchedulerSendFn,
  ): void {
    this.stopHeartbeat(agentId);

    const expression = INTERVAL_TO_CRON[config.intervalMins];
    const onlyWhenIdle = config.onlyWhenIdle !== false;

    this.logger.info({ agentId, expression, tz: config.tz ?? 'UTC', onlyWhenIdle }, 'Starting heartbeat');

    const job = new Cron(expression, { timezone: config.tz ?? 'UTC', protect: true }, () => {
      if (onlyWhenIdle && !isIdle()) {
        this.logger.debug({ agentId }, 'Heartbeat tick skipped — agent not idle');
        return;
      }
      this.logger.info({ agentId }, 'Heartbeat tick firing');
      send(agentId, '');
    });

    this.heartbeats.set(agentId, job);
  }

  stopHeartbeat(agentId: string): void {
    const existing = this.heartbeats.get(agentId);
    if (existing) {
      existing.stop();
      this.heartbeats.delete(agentId);
      this.logger.info({ agentId }, 'Heartbeat stopped');
    }
  }

  // ── Cron jobs ──

  startCronJob(
    job: CronJobConfig,
    send: SchedulerSendFn,
    spawn: SchedulerSpawnFn,
    onComplete?: (jobId: string) => void,
  ): void {
    this.stopCronJob(job.id);
    this.jobConfigs.set(job.id, job);

    this.logger.info({ jobId: job.id, schedule: job.schedule, session: job.session, tz: job.tz ?? 'UTC' }, 'Starting cron job');

    const instance = new Cron(job.schedule, { timezone: job.tz ?? 'UTC', protect: true }, () => {
      this.logger.info({ jobId: job.id, agentId: job.agentId }, 'Cron job firing');

      // Announce to TG if enabled (default: true)
      if (job.announce !== false && this.announceFn) {
        const label = job.name ?? job.id;
        this.announceFn(job.agentId, `\u23F0 Cron job <code>${escapeHtmlBasic(label)}</code> firing`);
      }

      // Update dynamic job runtime stats
      const dynJob = this.dynamicJobs.get(job.id);
      if (dynJob) {
        dynJob.runCount++;
        dynJob.lastRunAt = new Date().toISOString();
        this.saveDynamicJobs();
      }

      if (job.session === 'isolated') {
        spawn(job);
      } else {
        send(job.agentId, job.message);
      }

      if (job.deleteAfterRun) {
        instance.stop();
        this.cronJobs.delete(job.id);
        this.jobConfigs.delete(job.id);
        // Remove from dynamic persistence
        if (this.dynamicJobs.has(job.id)) {
          this.dynamicJobs.delete(job.id);
          this.saveDynamicJobs();
        }
        onComplete?.(job.id);
      }
    });

    this.cronJobs.set(job.id, instance);
  }

  stopCronJob(jobId: string): void {
    const existing = this.cronJobs.get(jobId);
    if (existing) {
      existing.stop();
      this.cronJobs.delete(jobId);
    }
    this.jobConfigs.delete(jobId);
  }

  startAllCronJobs(
    jobs: CronJobConfig[],
    send: SchedulerSendFn,
    spawn: SchedulerSpawnFn,
    onComplete?: (jobId: string) => void,
  ): void {
    for (const job of jobs) {
      this.staticJobIds.add(job.id);
      this.startCronJob(job, send, spawn, onComplete);
    }
  }

  stopAllCronJobs(): void {
    for (const [jobId, job] of this.cronJobs) {
      job.stop();
      this.logger.info({ jobId }, 'Cron job stopped');
    }
    this.cronJobs.clear();
    this.jobConfigs.clear();
    this.staticJobIds.clear();
    // Note: dynamicJobs map is NOT cleared here — it persists across config reloads
  }

  // ── Dynamic job management ──

  /** Add a dynamic cron job. Persists to disk and starts the cron. */
  addDynamicJob(
    job: CronJobConfig,
    send: SchedulerSendFn,
    spawn: SchedulerSpawnFn,
  ): DynamicCronJob {
    const dynJob: DynamicCronJob = {
      ...job,
      createdAt: new Date().toISOString(),
      runCount: 0,
      lastRunAt: null,
    };

    this.dynamicJobs.set(job.id, dynJob);
    this.saveDynamicJobs();

    // Wire the onComplete to remove from persistence on deleteAfterRun
    this.startCronJob(job, send, spawn, (jobId) => {
      this.dynamicJobs.delete(jobId);
      this.saveDynamicJobs();
      this.logger.info({ jobId }, 'One-shot cron job completed and removed');
    });

    return dynJob;
  }

  /** Remove a dynamic cron job by ID. Returns true if found and removed. */
  removeDynamicJob(jobId: string): boolean {
    const existed = this.dynamicJobs.has(jobId);
    if (existed) {
      this.stopCronJob(jobId);
      this.dynamicJobs.delete(jobId);
      this.saveDynamicJobs();
      this.logger.info({ jobId }, 'Dynamic cron job removed');
    }
    return existed;
  }

  /** Trigger a cron job immediately by ID. Returns true if found. */
  triggerJob(
    jobId: string,
    send: SchedulerSendFn,
    spawn: SchedulerSpawnFn,
  ): boolean {
    const job = this.jobConfigs.get(jobId);
    if (!job) return false;

    this.logger.info({ jobId: job.id, agentId: job.agentId }, 'Cron job manually triggered');

    // Announce to TG if enabled
    if (job.announce !== false && this.announceFn) {
      const label = job.name ?? job.id;
      this.announceFn(job.agentId, `\u23F0 Cron job <code>${escapeHtmlBasic(label)}</code> manually triggered`);
    }

    // Update dynamic job runtime stats
    const dynJob = this.dynamicJobs.get(jobId);
    if (dynJob) {
      dynJob.runCount++;
      dynJob.lastRunAt = new Date().toISOString();
      this.saveDynamicJobs();
    }

    if (job.session === 'isolated') {
      spawn(job);
    } else {
      send(job.agentId, job.message);
    }

    // Handle deleteAfterRun for manual trigger too
    if (job.deleteAfterRun) {
      this.stopCronJob(jobId);
      if (this.dynamicJobs.has(jobId)) {
        this.dynamicJobs.delete(jobId);
        this.saveDynamicJobs();
      }
    }

    return true;
  }

  // ── Query ──

  /** List all active cron jobs with next-run information. */
  listJobs(): CronJobInfo[] {
    const result: CronJobInfo[] = [];

    for (const [jobId, config] of this.jobConfigs) {
      const cronInstance = this.cronJobs.get(jobId);
      const nextRun = cronInstance?.nextRun() ?? null;
      const dynJob = this.dynamicJobs.get(jobId);
      const source = this.staticJobIds.has(jobId) ? 'static' as const : 'dynamic' as const;

      result.push({
        id: config.id,
        name: config.name,
        schedule: config.schedule,
        tz: config.tz,
        agentId: config.agentId,
        message: config.message,
        session: config.session,
        announce: config.announce,
        deleteAfterRun: config.deleteAfterRun,
        source,
        nextRun,
        runCount: dynJob?.runCount,
        lastRunAt: dynJob?.lastRunAt,
        createdAt: dynJob?.createdAt,
      });
    }

    // Sort by next run time (soonest first), nulls at end
    result.sort((a, b) => {
      if (!a.nextRun && !b.nextRun) return 0;
      if (!a.nextRun) return 1;
      if (!b.nextRun) return -1;
      return a.nextRun.getTime() - b.nextRun.getTime();
    });

    return result;
  }

  /** Check if a job ID exists (static or dynamic). */
  hasJob(jobId: string): boolean {
    return this.jobConfigs.has(jobId);
  }

  // ── Persistence ──

  /** Save dynamic jobs to ~/.config/tgcc/cron-jobs.json */
  saveDynamicJobs(): void {
    try {
      const dir = dirname(DYNAMIC_JOBS_PATH);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const jobs = [...this.dynamicJobs.values()];
      writeFileSync(DYNAMIC_JOBS_PATH, JSON.stringify(jobs, null, 2) + '\n');
      this.logger.debug({ count: jobs.length, path: DYNAMIC_JOBS_PATH }, 'Dynamic cron jobs saved');
    } catch (err) {
      this.logger.error({ err }, 'Failed to save dynamic cron jobs');
    }
  }

  /** Load dynamic jobs from ~/.config/tgcc/cron-jobs.json and start them. */
  loadDynamicJobs(
    send: SchedulerSendFn,
    spawn: SchedulerSpawnFn,
    validAgentIds: Set<string>,
  ): void {
    if (!existsSync(DYNAMIC_JOBS_PATH)) {
      this.logger.debug('No dynamic cron jobs file found');
      return;
    }

    try {
      const raw = JSON.parse(readFileSync(DYNAMIC_JOBS_PATH, 'utf-8'));
      if (!Array.isArray(raw)) {
        this.logger.warn('Dynamic cron jobs file is not an array');
        return;
      }

      let loaded = 0;
      let skipped = 0;

      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        if (!entry.id || !entry.schedule || !entry.agentId || !entry.message) {
          skipped++;
          continue;
        }
        // Skip jobs targeting agents that no longer exist
        if (!validAgentIds.has(entry.agentId)) {
          this.logger.warn({ jobId: entry.id, agentId: entry.agentId }, 'Skipping dynamic job — agent not found');
          skipped++;
          continue;
        }

        const dynJob: DynamicCronJob = {
          id: entry.id,
          name: entry.name ?? undefined,
          schedule: entry.schedule,
          tz: entry.tz ?? undefined,
          agentId: entry.agentId,
          message: entry.message,
          session: entry.session ?? 'main',
          announce: entry.announce ?? true,
          model: entry.model ?? undefined,
          timeoutMs: entry.timeoutMs ?? undefined,
          deleteAfterRun: entry.deleteAfterRun ?? false,
          createdAt: entry.createdAt ?? new Date().toISOString(),
          runCount: entry.runCount ?? 0,
          lastRunAt: entry.lastRunAt ?? null,
        };

        this.dynamicJobs.set(dynJob.id, dynJob);

        // Start the cron job (wire onComplete for deleteAfterRun cleanup)
        this.startCronJob(dynJob, send, spawn, (jobId) => {
          this.dynamicJobs.delete(jobId);
          this.saveDynamicJobs();
          this.logger.info({ jobId }, 'One-shot cron job completed and removed');
        });

        loaded++;
      }

      this.logger.info({ loaded, skipped, path: DYNAMIC_JOBS_PATH }, 'Dynamic cron jobs loaded');
    } catch (err) {
      this.logger.error({ err }, 'Failed to load dynamic cron jobs');
    }
  }

  // ── Lifecycle ──

  stopAll(): void {
    for (const [agentId, job] of this.heartbeats) {
      job.stop();
      this.logger.info({ agentId }, 'Heartbeat stopped (shutdown)');
    }
    this.heartbeats.clear();
    this.stopAllCronJobs();
  }
}

// ── Utility ──

/** Minimal HTML escaper for use in announce messages. */
function escapeHtmlBasic(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
