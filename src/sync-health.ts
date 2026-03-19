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
  /** Max age in hours before considered stale */
  maxAgeHours: number;
  /** Pattern that indicates successful completion */
  successPattern: RegExp;
  /** Pattern that indicates errors (captures count if possible) */
  errorPattern?: RegExp;
}

const SYNC_JOBS: SyncJob[] = [
  {
    name: 'Email sync',
    logFile: 'email_sync.log',
    maxAgeHours: 2, // runs hourly
    successPattern: /=== Email sync finished ===/,
    errorPattern: /\(([1-9]\d*) chyb/,
  },
  {
    name: 'Calendar sync',
    logFile: 'calendar_sync.log',
    maxAgeHours: 0.5, // runs every 15 min
    successPattern: /calendar.*sync|events? (upserted|synced|processed)/i,
    errorPattern: /Error|database is locked/,
  },
  {
    name: 'Contacts sync',
    logFile: 'contacts_sync.log',
    maxAgeHours: 26, // runs daily 5:30
    successPattern: /=== Google Contacts sync done ===/,
  },
  {
    name: 'Doc sync',
    logFile: 'doc_sync.log',
    maxAgeHours: 26, // runs daily 6:00
    successPattern: /=== Doc sync (finished|done) ===/,
    errorPattern: /(\d+) chyb/,
  },
  {
    name: 'Commitments',
    logFile: 'commitments.log',
    maxAgeHours: 26, // runs daily 7:00
    successPattern: /=== Commitment tracker finished ===/,
    errorPattern: /ERROR:|WARNING:/,
  },
  {
    name: 'Post-briefing',
    logFile: 'post_briefing.log',
    maxAgeHours: 26, // runs daily 6:35
    successPattern: /=== Post-briefing done ===/,
  },
];

interface HealthResult {
  job: string;
  ok: boolean;
  issue?: string;
  lastRun?: Date;
}

function checkJob(job: SyncJob): HealthResult {
  const logPath = path.join(CONE_LOGS, job.logFile);

  if (!fs.existsSync(logPath)) {
    return { job: job.name, ok: false, issue: 'log soubor neexistuje' };
  }

  const stat = fs.statSync(logPath);
  const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);

  if (ageHours > job.maxAgeHours) {
    const ago = ageHours < 1
      ? `${Math.round(ageHours * 60)} min`
      : `${Math.round(ageHours)} hod`;
    return {
      job: job.name,
      ok: false,
      issue: `neběžel ${ago} (limit ${job.maxAgeHours} hod)`,
      lastRun: stat.mtime,
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
    };
  }

  if (job.errorPattern) {
    const match = tail.match(job.errorPattern);
    if (match) {
      const count = match[1] || '';
      const errCount = parseInt(count, 10);
      // Small number of errors in email sync is normal (attachment issues)
      if (job.logFile === 'email_sync.log' && errCount > 0 && errCount <= 100) {
        return { job: job.name, ok: true, lastRun: stat.mtime };
      }
      return {
        job: job.name,
        ok: false,
        issue: `chyby v logu${count ? ` (${count})` : ''}`,
        lastRun: stat.mtime,
      };
    }
  }

  return { job: job.name, ok: true, lastRun: stat.mtime };
}

/**
 * Check all sync jobs and return a summary.
 * Returns null if everything is OK.
 */
export function checkSyncHealth(): string | null {
  const results = SYNC_JOBS.map(checkJob);
  const failures = results.filter((r) => !r.ok);

  if (failures.length === 0) {
    logger.info('Sync health check: all OK');
    return null;
  }

  logger.warn({ failures }, 'Sync health check: issues found');

  const lines = failures.map(
    (f) => `⚠️ ${f.job}: ${f.issue}`,
  );

  return `*Sync health check*\n${lines.join('\n')}`;
}
