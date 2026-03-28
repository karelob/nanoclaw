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
    // If the log was modified very recently (<2 min), sync is likely still running
    const ageMinutes = (Date.now() - stat.mtimeMs) / 60000;
    if (ageMinutes < 2) {
      logger.info({ job: job.name, ageMinutes: Math.round(ageMinutes * 10) / 10 }, 'Sync likely still running, skipping');
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
 * Check if cone.db is locked by a long-running process.
 */
function checkDbLock(): string | null {
  try {
    const { execFileSync } = require('child_process');
    const lsofOut = execFileSync(
      'lsof',
      [
        path.join(
          process.env.HOME || '/Users/karel',
          'Develop/nano-cone/cone/db/cone.db',
        ),
      ],
      { timeout: 5000, encoding: 'utf8' },
    ).trim();

    const lines = lsofOut.split('\n').slice(1); // skip header
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const cmd = parts[0];
      const pid = parts[1];
      if (!pid) continue;
      // Check process runtime
      try {
        const ps = execFileSync('ps', ['-p', pid, '-o', 'etime='], {
          timeout: 3000,
          encoding: 'utf8',
        }).trim();
        // Parse elapsed time (MM:SS or HH:MM:SS or D-HH:MM:SS)
        const parts2 = ps.split(/[:-]/).map(Number);
        let totalMins = 0;
        if (parts2.length === 2) totalMins = parts2[0];
        else if (parts2.length === 3) totalMins = parts2[0] * 60 + parts2[1];
        else if (parts2.length === 4)
          totalMins = parts2[0] * 24 * 60 + parts2[1] * 60 + parts2[2];

        if (totalMins > 15) {
          // Auto-kill processes holding DB lock >15 min
          try {
            process.kill(parseInt(pid, 10), 'SIGTERM');
            logger.warn(
              { cmd, pid, elapsed: ps.trim() },
              'Auto-killed long-running DB lock holder',
            );
            return `🔄 cone.db was locked by ${cmd} (PID ${pid}) for ${ps.trim()} — auto-killed`;
          } catch {
            return `⚠️ cone.db locked by ${cmd} (PID ${pid}) for ${ps.trim()} — kill failed`;
          }
        } else if (totalMins > 10) {
          return `⚠️ cone.db locked by ${cmd} (PID ${pid}) for ${ps.trim()}`;
        }
      } catch {
        /* process may have exited */
      }
    }
  } catch {
    // lsof returns non-zero if no matches — that's fine (no locks)
  }
  return null;
}

/**
 * Check all sync jobs. Returns null if everything OK (for alerting).
 */
export function checkSyncHealth(): string | null {
  const results = SYNC_JOBS.map(checkJob);
  const failures = results.filter((r) => !r.ok);

  // Also check DB lock
  const dbLock = checkDbLock();
  if (dbLock) {
    failures.push({
      job: 'DB Lock',
      ok: false,
      issue: dbLock,
      launchdLabel: '',
    });
  }

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
