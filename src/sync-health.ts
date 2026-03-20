/**
 * Health check for LaunchAgent sync jobs.
 * Parses log files to detect failures and stale syncs.
 * Runs on host (no container, no tokens).
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

const CONE_LOGS = path.join(
  process.env.HOME || '/Users/karel',
  'Develop/nano-cone/cone/logs',
);

interface SyncJob {
  name: string;
  logFile: string;
  launchdLabel: string;
  /** Max age in hours before considered stale */
  maxAgeHours: number;
  /** Pattern that indicates successful completion */
  successPattern: RegExp;
  /** Pattern that indicates errors (captures count if possible) */
  errorPattern?: RegExp;
}

export const SYNC_JOBS: SyncJob[] = [
  {
    name: 'Email sync',
    logFile: 'email_sync.log',
    launchdLabel: 'com.cone.email-sync',
    maxAgeHours: 2,
    successPattern: /=== Email sync finished ===/,
    errorPattern: /\(([1-9]\d*) chyb/,
  },
  {
    name: 'Calendar sync',
    logFile: 'calendar_sync.log',
    launchdLabel: 'com.cone.calendar-sync',
    maxAgeHours: 0.5,
    successPattern: /calendar_sync OK/,
    errorPattern: /calendar_sync FAILED/,
  },
  {
    name: 'Contacts sync',
    logFile: 'contacts_sync.log',
    launchdLabel: 'com.cone.contacts-sync',
    maxAgeHours: 26,
    successPattern: /=== Google Contacts sync done ===/,
  },
  {
    name: 'Doc sync',
    logFile: 'doc_sync.log',
    launchdLabel: 'com.cone.doc-sync',
    maxAgeHours: 26,
    successPattern: /=== Doc sync (finished|done) ===/,
    errorPattern: /(\d+) chyb/,
  },
  {
    name: 'Commitments',
    logFile: 'commitments.log',
    launchdLabel: 'com.cone.commitments',
    maxAgeHours: 26,
    successPattern: /=== Commitment tracker finished ===/,
    errorPattern: /ERROR:|WARNING:/,
  },
  {
    name: 'Post-briefing',
    logFile: 'post_briefing.log',
    launchdLabel: 'com.cone.post-briefing',
    maxAgeHours: 26,
    successPattern: /=== Post-briefing done ===/,
  },
];

export interface HealthResult {
  job: string;
  ok: boolean;
  issue?: string;
  lastRun?: Date;
  launchdLabel: string;
}

export function checkJob(job: SyncJob): HealthResult {
  const logPath = path.join(CONE_LOGS, job.logFile);

  if (!fs.existsSync(logPath)) {
    return {
      job: job.name,
      ok: false,
      issue: 'log soubor neexistuje',
      launchdLabel: job.launchdLabel,
    };
  }

  const stat = fs.statSync(logPath);
  const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);

  if (ageHours > job.maxAgeHours) {
    const ago =
      ageHours < 1
        ? `${Math.round(ageHours * 60)} min`
        : `${Math.round(ageHours)} hod`;
    return {
      job: job.name,
      ok: false,
      issue: `neběžel ${ago} (limit ${job.maxAgeHours} hod)`,
      lastRun: stat.mtime,
      launchdLabel: job.launchdLabel,
    };
  }

  // Read last 2KB of log to check for success/errors
  const fd = fs.openSync(logPath, 'r');
  const size = stat.size;
  const readSize = Math.min(size, 2048);
  const buf = Buffer.alloc(readSize);
  fs.readSync(fd, buf, 0, readSize, Math.max(0, size - readSize));
  fs.closeSync(fd);
  const tail = buf.toString('utf8');

  if (!job.successPattern.test(tail)) {
    return {
      job: job.name,
      ok: false,
      issue: 'poslední běh neobsahuje úspěšné dokončení',
      lastRun: stat.mtime,
      launchdLabel: job.launchdLabel,
    };
  }

  if (job.errorPattern) {
    const match = tail.match(job.errorPattern);
    if (match) {
      const count = match[1] || '';
      const errCount = parseInt(count, 10);
      if (job.logFile === 'email_sync.log' && errCount > 0 && errCount <= 100) {
        return {
          job: job.name,
          ok: true,
          lastRun: stat.mtime,
          launchdLabel: job.launchdLabel,
        };
      }
      return {
        job: job.name,
        ok: false,
        issue: `chyby v logu${count ? ` (${count})` : ''}`,
        lastRun: stat.mtime,
        launchdLabel: job.launchdLabel,
      };
    }
  }

  return {
    job: job.name,
    ok: true,
    lastRun: stat.mtime,
    launchdLabel: job.launchdLabel,
  };
}

function formatAge(date: Date): string {
  const mins = Math.round((Date.now() - date.getTime()) / 60000);
  if (mins < 60) return `${mins} min`;
  return `${Math.round(mins / 60)} hod`;
}

/**
 * Check all sync jobs. Returns null if everything OK (for alerting).
 */
export function checkSyncHealth(): string | null {
  const results = SYNC_JOBS.map(checkJob);
  const failures = results.filter((r) => !r.ok);

  if (failures.length === 0) {
    logger.info('Sync health check: all OK');
    return null;
  }

  logger.warn({ failures }, 'Sync health check: issues found');
  const lines = failures.map((f) => `⚠️ ${f.job}: ${f.issue}`);
  return `*Sync health check*\n${lines.join('\n')}`;
}

/**
 * Full health report (for !health command). Always returns a message.
 */
export function getFullHealthReport(): string {
  const results = SYNC_JOBS.map(checkJob);
  const lines = results.map((r) => {
    const ago = r.lastRun ? formatAge(r.lastRun) : '?';
    return r.ok ? `✅ ${r.job} — ${ago} ago` : `⚠️ ${r.job} — ${r.issue}`;
  });
  return `*Sync Health Report*\n${lines.join('\n')}`;
}
