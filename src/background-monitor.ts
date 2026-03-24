/**
 * Background Monitor — Tier 1 (Node.js, no LLM) + Tier 2 (Ollama analysis)
 *
 * Tier 1: Health checks every 5 minutes (free, deterministic)
 *   - Sync job freshness (existing sync-health.ts)
 *   - DB lock detection + auto-kill (existing)
 *   - Disk space
 *   - Backup freshness
 *   - Ollama availability
 *   - NanoClaw process health
 *
 * Tier 2: Ollama analysis every hour (free, pattern detection)
 *   - Collects Tier 1 metrics over time
 *   - Sends structured prompt to Ollama
 *   - Writes report to knowledge/tracking/system_health.md
 *   - Alerts Telegram if health score drops
 *
 * Principles:
 *   - Alert only on STATE CHANGES (not every check)
 *   - Proposals, not actions (except auto-kill for DB locks)
 *   - Escalation: Tier 1 detects → Tier 2 analyzes
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { KNOWLEDGE_REPO_PATH, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { runResearchAgent } from './research-agent.js';
import {
  checkSyncHealth,
  getFullHealthReport,
  SYNC_JOBS,
  checkJob,
} from './sync-health.js';

const RESEARCH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

// ── Config ──────────────────────────────────────────
const HOME = process.env.HOME || '/Users/karel';
const CONE_DB = path.join(HOME, 'Develop/nano-cone/cone/db/cone.db');
const CONE_LOGS = path.join(HOME, 'Develop/nano-cone/cone/logs');
const BACKUP_LOG = path.join(CONE_LOGS, 'backup.log');
const OLLAMA_URL = 'http://10.0.10.70:11434';
const OLLAMA_MODEL = 'qwen2.5:14b';

const TIER1_INTERVAL = 5 * 60 * 1000; // 5 minutes
const TIER2_INTERVAL = 60 * 60 * 1000; // 1 hour
const HEALTH_REPORT_PATH = path.join(
  KNOWLEDGE_REPO_PATH,
  'tracking',
  'system_health.md',
);

// ── State tracking (alert only on changes) ──────────
interface MonitorState {
  lastAlerts: Set<string>;
  metrics: MetricsSnapshot[];
  lastTier2: number;
}

interface MetricsSnapshot {
  ts: string;
  syncHealth: string | null;
  dbLocked: boolean;
  diskFreeGB: number;
  diskUsedPct: number;
  coneDbSizeMB: number;
  backupNasAgeDays: number;
  backupB2AgeDays: number;
  ollamaUp: boolean;
  processMemMB: number;
  errors: string[];
}

// Ollama must be up N consecutive checks before we trust it enough to alert on failures
const OLLAMA_STABLE_THRESHOLD = 12; // 12 × 5min = 1 hour of consecutive OK

const state: MonitorState & { lastResearch: number; ollamaConsecutiveOk: number; ollamaAlertEnabled: boolean } = {
  lastAlerts: new Set(),
  metrics: [],
  lastTier2: 0,
  lastResearch: 0,
  ollamaConsecutiveOk: 0,
  ollamaAlertEnabled: false,
};

// ── Tier 1: Deterministic health checks ─────────────

function checkDiskSpace(): { freeGB: number; usedPct: number } {
  try {
    const stats = fs.statfsSync('/');
    const totalBytes = stats.bsize * stats.blocks;
    const freeBytes = stats.bsize * stats.bavail;
    const freeGB = freeBytes / 1e9;
    const usedPct = Math.round(((totalBytes - freeBytes) / totalBytes) * 100);
    return { freeGB: Math.round(freeGB), usedPct };
  } catch {
    return { freeGB: -1, usedPct: -1 };
  }
}

function checkConeDbSize(): number {
  try {
    return Math.round(fs.statSync(CONE_DB).size / 1e6);
  } catch {
    return -1;
  }
}

function checkBackupAge(): { nasDays: number; b2Days: number } {
  const result = { nasDays: -1, b2Days: -1 };
  try {
    const log = fs.readFileSync(BACKUP_LOG, 'utf8');
    const lines = log.split('\n');

    for (let i = lines.length - 1; i >= 0; i--) {
      if (
        lines[i].includes('NAS: Hotovo') ||
        lines[i].includes('NAS: hotovo')
      ) {
        const match = lines[i].match(/(\d{4}-\d{2}-\d{2})/);
        if (match) {
          result.nasDays = Math.round(
            (Date.now() - new Date(match[1]).getTime()) / 86400000,
          );
          break;
        }
      }
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('B2: Hotovo') || lines[i].includes('B2: hotovo')) {
        const match = lines[i].match(/(\d{4}-\d{2}-\d{2})/);
        if (match) {
          result.b2Days = Math.round(
            (Date.now() - new Date(match[1]).getTime()) / 86400000,
          );
          break;
        }
      }
    }
  } catch {
    /* log may not exist */
  }
  return result;
}

function checkOllama(): boolean {
  // Retry twice — intermittent EHOSTUNREACH from launchd process
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = execFileSync(
        '/usr/bin/curl',
        [
          '-s',
          '--connect-timeout',
          '5',
          '--max-time',
          '8',
          `${OLLAMA_URL}/api/tags`,
        ],
        { timeout: 12000, encoding: 'utf8' },
      );
      if (resp.includes('models')) return true;
    } catch {
      /* retry */
    }
  }
  return false;
}

function checkProcessHealth(): number {
  const mem = process.memoryUsage();
  return Math.round(mem.rss / 1e6);
}

function getRecentErrors(): string[] {
  const errors: string[] = [];
  const logFiles = [
    { file: 'calendar_sync.log', pattern: /FAILED/ },
    { file: 'email_sync.log', pattern: /WARN|ERROR/ },
    { file: 'commitments.log', pattern: /WARNING|ERROR/ },
  ];

  for (const { file, pattern } of logFiles) {
    try {
      const logPath = path.join(CONE_LOGS, file);
      const fd = fs.openSync(logPath, 'r');
      const stat = fs.fstatSync(fd);
      const readSize = Math.min(stat.size, 2048);
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, Math.max(0, stat.size - readSize));
      fs.closeSync(fd);
      const tail = buf.toString('utf8');

      for (const line of tail.split('\n')) {
        if (pattern.test(line) && line.includes('2026-03-')) {
          const dateMatch = line.match(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
          if (dateMatch) {
            const errorAge = Date.now() - new Date(dateMatch[0]).getTime();
            if (errorAge < 24 * 60 * 60 * 1000) {
              errors.push(`[${file}] ${line.trim().slice(0, 120)}`);
            }
          }
        }
      }
    } catch {
      /* skip */
    }
  }
  return errors.slice(-10);
}

function collectMetrics(): MetricsSnapshot {
  const syncAlert = checkSyncHealth();
  const disk = checkDiskSpace();
  const backup = checkBackupAge();

  return {
    ts: new Date().toISOString(),
    syncHealth: syncAlert,
    dbLocked: syncAlert?.includes('DB Lock') ?? false,
    diskFreeGB: disk.freeGB,
    diskUsedPct: disk.usedPct,
    coneDbSizeMB: checkConeDbSize(),
    backupNasAgeDays: backup.nasDays,
    backupB2AgeDays: backup.b2Days,
    ollamaUp: checkOllama(),
    processMemMB: checkProcessHealth(),
    errors: getRecentErrors(),
  };
}

// ── Alert with state change detection ───────────────

function generateAlerts(m: MetricsSnapshot): { key: string; msg: string }[] {
  const alerts: { key: string; msg: string }[] = [];

  if (m.syncHealth) {
    alerts.push({ key: 'sync', msg: m.syncHealth });
  }

  if (m.diskUsedPct > 90) {
    alerts.push({
      key: 'disk',
      msg: `⚠️ Disk ${m.diskUsedPct}% full (${m.diskFreeGB}GB free)`,
    });
  }

  if (m.backupNasAgeDays > 3) {
    alerts.push({
      key: 'backup-nas',
      msg: `⚠️ NAS backup ${m.backupNasAgeDays} dní starý`,
    });
  }

  if (m.backupB2AgeDays > 8) {
    alerts.push({
      key: 'backup-b2',
      msg: `⚠️ B2 backup ${m.backupB2AgeDays} dní starý`,
    });
  }

  // Ollama: track consecutive OK checks, only alert after stable period
  if (m.ollamaUp) {
    state.ollamaConsecutiveOk++;
    if (!state.ollamaAlertEnabled && state.ollamaConsecutiveOk >= OLLAMA_STABLE_THRESHOLD) {
      state.ollamaAlertEnabled = true;
      logger.info({ consecutiveOk: state.ollamaConsecutiveOk }, 'Ollama stable — alerts enabled');
    }
  } else {
    state.ollamaConsecutiveOk = 0;
    if (state.ollamaAlertEnabled) {
      alerts.push({ key: 'ollama', msg: '⚠️ Ollama nedostupný (10.0.10.70)' });
    }
  }

  if (m.processMemMB > 1000) {
    alerts.push({
      key: 'memory',
      msg: `⚠️ NanoClaw ${m.processMemMB}MB RAM`,
    });
  }

  return alerts;
}

// ── Tier 2: Ollama analysis ─────────────────────────

async function runOllamaAnalysis(
  metrics: MetricsSnapshot[],
): Promise<string | null> {
  if (metrics.length === 0) return null;

  const latest = metrics[metrics.length - 1];
  const syncResults = SYNC_JOBS.map(checkJob);

  const syncSummary = syncResults
    .map((r) => {
      const ago = r.lastRun
        ? `${Math.round((Date.now() - r.lastRun.getTime()) / 60000)} min ago`
        : 'unknown';
      return `  ${r.job}: ${r.ok ? 'ok' : r.issue} (${ago})`;
    })
    .join('\n');

  const metricsHistory = metrics.slice(-12).map((m) => ({
    ts: m.ts.slice(11, 16),
    disk: m.diskUsedPct,
    mem: m.processMemMB,
    dbLocked: m.dbLocked,
    errors: m.errors.length,
  }));

  const prompt = `System health snapshot (${latest.ts}):

SYNC_JOBS:
${syncSummary}

DB: cone.db ${latest.coneDbSizeMB}MB, locked=${latest.dbLocked}
DISK: ${latest.diskUsedPct}% used, ${latest.diskFreeGB}GB free
MEMORY: NanoClaw ${latest.processMemMB}MB RSS
OLLAMA: ${latest.ollamaUp ? 'up' : 'DOWN'}

BACKUP:
  NAS: last success ${latest.backupNasAgeDays} days ago ${latest.backupNasAgeDays > 7 ? '⚠️ CRITICAL' : ''}
  B2: last success ${latest.backupB2AgeDays} days ago ${latest.backupB2AgeDays > 7 ? '⚠️' : ''}

ERRORS_LAST_24H (${latest.errors.length}):
${latest.errors.map((e) => `  - ${e}`).join('\n') || '  none'}

METRICS_TREND (last ${metricsHistory.length} checks):
${JSON.stringify(metricsHistory, null, 1)}

Analyze. Output JSON only:
{"score":1-10,"trend":"improving|stable|degrading","anomalies":["..."],"recommendations":["..."]}`;

  // Use curl to avoid Node.js undici EHOSTUNREACH bug with 10.0.10.70
  try {
    const payload = JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      system:
        'You are a system health analyst. Analyze metrics, detect anomalies, score health 1-10. Output ONLY valid JSON, no explanation.',
      stream: false,
    });

    // Write payload to temp file to avoid shell escaping issues with curl -d
    const tmpPayload = path.join(os.tmpdir(), 'nanoclaw-ollama-payload.json');
    fs.writeFileSync(tmpPayload, payload);
    try {
      const stdout = execFileSync(
        '/usr/bin/curl',
        [
          '-s',
          '--connect-timeout',
          '10',
          '--max-time',
          '60',
          '-X',
          'POST',
          `${OLLAMA_URL}/api/generate`,
          '-H',
          'Content-Type: application/json',
          '-d',
          `@${tmpPayload}`,
        ],
        { timeout: 65_000, encoding: 'utf8' },
      );
      const data = JSON.parse(stdout) as { response?: string };
      return data.response?.trim() || null;
    } finally {
      try {
        fs.unlinkSync(tmpPayload);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ error: msg.slice(0, 300) }, 'Ollama analysis failed');
    return null;
  }
}

function writeHealthReport(
  metrics: MetricsSnapshot,
  analysis: string | null,
): void {
  try {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    let report = `# System Health\n\n> Auto-generated by background-monitor. Updated ${now}.\n\n`;

    report += `## Current State\n\n`;
    report += `| Metric | Value |\n|--------|-------|\n`;
    report += `| Disk | ${metrics.diskUsedPct}% (${metrics.diskFreeGB}GB free) |\n`;
    report += `| cone.db | ${metrics.coneDbSizeMB} MB |\n`;
    report += `| NanoClaw RAM | ${metrics.processMemMB} MB |\n`;
    report += `| Ollama | ${metrics.ollamaUp ? '✅' : '❌'} |\n`;
    report += `| Backup NAS | ${metrics.backupNasAgeDays >= 0 ? metrics.backupNasAgeDays + ' days ago' : 'unknown'} |\n`;
    report += `| Backup B2 | ${metrics.backupB2AgeDays >= 0 ? metrics.backupB2AgeDays + ' days ago' : 'unknown'} |\n`;
    report += `| DB Lock | ${metrics.dbLocked ? '⚠️ YES' : 'no'} |\n`;
    report += `| Errors (24h) | ${metrics.errors.length} |\n`;

    if (analysis) {
      report += `\n## Ollama Analysis\n\n\`\`\`json\n${analysis}\n\`\`\`\n`;
    }

    if (metrics.errors.length > 0) {
      report += `\n## Recent Errors\n\n`;
      for (const e of metrics.errors) {
        report += `- ${e}\n`;
      }
    }

    fs.writeFileSync(HEALTH_REPORT_PATH, report);
  } catch (err) {
    logger.warn({ err }, 'Failed to write health report');
  }
}

// ── Main loop ───────────────────────────────────────

export function startBackgroundMonitor(
  sendAlert: (text: string) => Promise<void>,
): void {
  logger.info('Background monitor started (Tier 1: 5min, Tier 2: 1hr)');

  const runTier1 = async () => {
    try {
      const metrics = collectMetrics();
      state.metrics.push(metrics);
      // Keep last 24h of metrics (288 at 5min intervals)
      if (state.metrics.length > 288) state.metrics.shift();

      // Generate alerts and check for state changes
      const alerts = generateAlerts(metrics);
      const currentKeys = new Set(alerts.map((a) => a.key));
      const newAlerts = alerts.filter((a) => !state.lastAlerts.has(a.key));

      // Send only NEW alerts (state change)
      if (newAlerts.length > 0) {
        const msg = newAlerts.map((a) => a.msg).join('\n');
        await sendAlert(`*System Monitor*\n${msg}`);
      }

      // Clear resolved alerts
      for (const key of state.lastAlerts) {
        if (!currentKeys.has(key)) {
          state.lastAlerts.delete(key);
        }
      }
      for (const a of alerts) {
        state.lastAlerts.add(a.key);
      }

      // Tier 2: Ollama analysis (every hour)
      const now = Date.now();
      if (now - state.lastTier2 >= TIER2_INTERVAL) {
        state.lastTier2 = now;
        const latestMetrics = state.metrics[state.metrics.length - 1];

        if (!latestMetrics?.ollamaUp) {
          logger.info('Skipping Tier 2 — Ollama not available');
          writeHealthReport(latestMetrics, null);
        } else {
          logger.info('Running Tier 2 Ollama analysis');
        }

        const analysis = latestMetrics?.ollamaUp
          ? await runOllamaAnalysis(state.metrics)
          : null;
        writeHealthReport(metrics, analysis);

        if (analysis) {
          try {
            const parsed = JSON.parse(analysis);
            if (parsed.score && parsed.score < 7) {
              const anomalies = (parsed.anomalies || []).join(', ');
              await sendAlert(
                `*Health Score: ${parsed.score}/10* (${parsed.trend})\n${anomalies}`,
              );
            }
            logger.info(
              { score: parsed.score, trend: parsed.trend },
              'Ollama health analysis complete',
            );
          } catch {
            logger.warn('Ollama returned non-JSON response');
          }
        }
      }

      // Research agent (every 12 hours)
      if (now - state.lastResearch >= RESEARCH_INTERVAL) {
        state.lastResearch = now;
        try {
          await runResearchAgent(sendAlert);
        } catch (err) {
          logger.warn({ err }, 'Research agent failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'Background monitor error');
    }
  };

  // First Tier 1 after 2 minutes (let WhatsApp sync finish)
  // First Tier 2 and Research delayed
  state.lastTier2 = Date.now();
  state.lastResearch = Date.now() - RESEARCH_INTERVAL + 10 * 60 * 1000; // first run after 10 min
  setTimeout(runTier1, 2 * 60 * 1000);
  // Then every 5 minutes
  setInterval(runTier1, TIER1_INTERVAL);
}
