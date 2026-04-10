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
import { execFileSync, execSync } from 'child_process';
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
const RESEARCH_RETRY_INTERVAL = 10 * 60 * 1000; // 10 min retry when Moltbook is down

// ── Config ──────────────────────────────────────────
const HOME = process.env.HOME || '/Users/karel';
const CONE_DB = path.join(HOME, 'Develop/nano-cone/cone/db/cone.db');
const CONE_LOGS = path.join(HOME, 'Develop/nano-cone/cone/logs');
const BACKUP_LOG = path.join(CONE_LOGS, 'backup.log');
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://10.0.10.70:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';

const TIER1_INTERVAL = 5 * 60 * 1000; // 5 minutes
const TIER2_INTERVAL = 60 * 60 * 1000; // 1 hour
const HEALTH_REPORT_PATH = path.join(
  KNOWLEDGE_REPO_PATH,
  'tracking',
  'system_health.md',
);
const ACTION_CLAIMS_PATH = path.join(
  KNOWLEDGE_REPO_PATH,
  'tracking',
  'action_claims.json',
);

// ── Alert log and action items ──────────────────────

interface AlertLogEntry {
  ts: string;
  msg: string;
}

interface ActionItem {
  assignee: '@agent' | '@cli' | '@karel';
  key: string; // matches alert key for auto-resolve
  description: string;
  created: string;
  claimedBy?: string; // who is working on it
  claimedAt?: string;
  resolved?: string;
  resolvedBy?: string;
  resolvedNote?: string;
  telegramSent?: boolean; // true after escalation to Telegram
}

// Map alert keys to assignees and action descriptions
const ALERT_ACTION_MAP: Record<
  string,
  { assignee: '@agent' | '@cli' | '@karel'; action: string }
> = {
  sync: {
    assignee: '@agent',
    action:
      'Zkontrolovat sync log, zkusit opravit. Pokud nelze: vytvořit @cli task',
  },
  'email-freshness': {
    assignee: '@agent',
    action:
      'Zkontrolovat email sync log, zkusit opravit. Pokud nelze: vytvořit @cli task',
  },
  disk: { assignee: '@cli', action: 'Diagnostikovat využití disku, vyčistit' },
  'backup-nas': {
    assignee: '@agent',
    action:
      'Zkontrolovat backup.log, zkusit opravit. Pokud nelze: vytvořit @cli task',
  },
  'backup-nas-warn': {
    assignee: '@agent',
    action: 'Zkontrolovat backup.log varování, zkusit opravit',
  },
  'backup-b2': {
    assignee: '@agent',
    action:
      'Zkontrolovat B2 backup log, zkusit opravit. Pokud nelze: vytvořit @cli task',
  },
  'backup-b2-warn': {
    assignee: '@agent',
    action: 'Zkontrolovat B2 backup varování, zkusit opravit',
  },
  ollama: {
    assignee: '@cli',
    action: 'Diagnostikovat Ollama na 10.0.10.70, zkontrolovat síť',
  },
  memory: {
    assignee: '@cli',
    action: 'Diagnostikovat vysoké využití RAM NanoClaw',
  },
};

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
  backupNasWarnings: string[];
  backupB2AgeDays: number;
  backupB2Warnings: string[];
  ollamaUp: boolean;
  processMemMB: number;
  errors: string[];
}

// Ollama must be up N consecutive checks before we trust it enough to alert on failures
const OLLAMA_STABLE_THRESHOLD = 12; // 12 × 5min = 1 hour of consecutive OK

const state: MonitorState & {
  lastResearch: number;
  moltbookOk: boolean | undefined;
  ollamaConsecutiveOk: number;
  ollamaAlertEnabled: boolean;
  alertLog: AlertLogEntry[];
  actionItems: ActionItem[];
  lastOllamaAnalysis: string | null;
  keyFirstActiveAt: Record<string, number>; // ms timestamp when alert key FIRST fired in current episode
  keyLastResolvedAt: Record<string, number>; // ms timestamp when alert key last auto-resolved
  keyTelegramSent: Record<string, number>; // ms timestamp when Telegram was last sent for this key (within episode)
} = {
  lastAlerts: new Set(),
  metrics: [],
  lastTier2: 0,
  lastResearch: 0,
  moltbookOk: undefined, // unknown until first run
  ollamaConsecutiveOk: 0,
  ollamaAlertEnabled: false,
  alertLog: [],
  actionItems: [],
  lastOllamaAnalysis: null,
  keyFirstActiveAt: {},
  keyLastResolvedAt: {},
  keyTelegramSent: {},
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

function checkBackupAge(): {
  nasDays: number;
  b2Days: number;
  nasWarnings: string[];
  b2Warnings: string[];
} {
  const result = {
    nasDays: -1,
    b2Days: -1,
    nasWarnings: [] as string[],
    b2Warnings: [] as string[],
  };
  try {
    const log = fs.readFileSync(BACKUP_LOG, 'utf8');
    const lines = log.split('\n');

    // Find last NAS "Hotovo" and collect warnings from that run
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
          // Scan backwards from Hotovo to "Záloha zahájena" for WARNs
          for (let j = i - 1; j >= 0; j--) {
            if (lines[j].includes('=== Záloha zahájena')) break;
            if (lines[j].includes('WARN:')) {
              const warnMatch = lines[j].match(/WARN:\s*(.+)/);
              if (warnMatch) result.nasWarnings.push(warnMatch[1].trim());
            }
          }
          break;
        }
      }
    }

    // Find last B2 "Hotovo" and collect warnings from that run
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes('B2: Hotovo') || lines[i].includes('B2: hotovo')) {
        const match = lines[i].match(/(\d{4}-\d{2}-\d{2})/);
        if (match) {
          result.b2Days = Math.round(
            (Date.now() - new Date(match[1]).getTime()) / 86400000,
          );
          for (let j = i - 1; j >= 0; j--) {
            if (lines[j].includes('=== Záloha zahájena')) break;
            if (lines[j].includes('WARN:')) {
              const warnMatch = lines[j].match(/WARN:\s*(.+)/);
              if (warnMatch) {
                const warn = warnMatch[1].trim();
                // NAS nedostupný při B2 fallback = expected, ne chyba B2
                if (!warn.includes('NAS nedostupný')) {
                  result.b2Warnings.push(warn);
                }
              }
            }
          }
          break;
        }
      }
    }
  } catch {
    /* log may not exist */
  }
  return result;
}

// Ollama check — launchd Node.js process cannot reach LAN IPs directly
// (EHOSTUNREACH for 10.0.10.70 — likely macOS vmnet routing conflict).
// Workaround: write result to temp file from a separate bash wrapper,
// which CAN reach LAN from launchd context.
const OLLAMA_CHECK_FILE = '/tmp/ollama-check.json';

function checkOllama(): boolean {
  // Read result from file (written by periodic bash check)
  try {
    if (!fs.existsSync(OLLAMA_CHECK_FILE)) {
      // Bootstrap: run first check
      triggerOllamaCheck();
      return false;
    }
    const data = JSON.parse(fs.readFileSync(OLLAMA_CHECK_FILE, 'utf8'));
    const ageMs = Date.now() - new Date(data.ts).getTime();
    // Stale if older than 10 min
    if (ageMs > 10 * 60 * 1000) {
      triggerOllamaCheck();
      return false;
    }
    return data.ok === true;
  } catch {
    return false;
  }
}

function triggerOllamaCheck(): void {
  try {
    // Run curl in background bash — not as Node.js child, but as independent process
    // This avoids the LAN routing issue in Node.js launchd context
    execFileSync(
      '/bin/bash',
      [
        '-c',
        `(/usr/bin/curl -s --connect-timeout 5 --max-time 8 ${OLLAMA_URL}/api/tags > /tmp/ollama-check-raw.txt 2>&1 && echo '{"ok":true,"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ${OLLAMA_CHECK_FILE} || echo '{"ok":false,"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","err":"'$(cat /tmp/ollama-check-raw.txt | head -1)'"}' > ${OLLAMA_CHECK_FILE}) &`,
      ],
      { timeout: 1000 },
    );
  } catch {
    /* fire and forget */
  }
}

function checkProcessHealth(): number {
  const mem = process.memoryUsage();
  return Math.round(mem.rss / 1e6);
}

function getRecentErrors(): string[] {
  const errors: string[] = [];
  const logFiles = [
    { file: 'calendar_sync.log', pattern: /FAILED/ },
    { file: 'email_sync.log', pattern: /WARN|ERROR|Rate limit|chyb\)/ },
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

/** Check Burlak health — two-tier alerting based on absence + output.
 *
 * Tier 1 (5–12 h, or >12 h with no prior output): log only, no Telegram.
 * Tier 2 (>12 h AND prior run had output): escalate to Telegram.
 *
 * Rationale: Burlak may legitimately have nothing to do — a run that
 * produced no output is expected idle behaviour, not a failure. Only alert
 * when output was expected but the run is missing.
 */
function checkBurlakHealth(): {
  key: string;
  msg: string;
  logOnly?: boolean;
} | null {
  const statusFile = path.join(HOME, '.config/burlak/last_run.json');
  try {
    const raw = fs.readFileSync(statusFile, 'utf-8');
    const status = JSON.parse(raw) as {
      ts: string;
      status: 'success' | 'failed';
      exit_code?: number;
      had_output?: boolean;
    };
    const ageMs = Date.now() - new Date(status.ts).getTime();
    const ageH = ageMs / (1000 * 60 * 60);

    if (status.status === 'failed') {
      return {
        key: 'burlak-failed',
        msg: `⚠️ Burlak poslední run selhal (exit ${status.exit_code ?? '?'}, ${Math.round(ageH)}h ago)`,
      };
    }
    if (ageH > 12) {
      // Only escalate to Telegram if the previous run had output (output was expected)
      const hadOutput = status.had_output !== false; // default true for backwards compat
      if (hadOutput) {
        return {
          key: 'burlak-stale',
          msg: `⚠️ Burlak neběžel ${Math.round(ageH)}h (očekáváno každé 4h, předchozí run měl výstup)`,
        };
      }
      // Previous run had no output — log only, don't spam Telegram
      logger.info(
        { ageH: Math.round(ageH) },
        'Burlak stale but previous run had no output — log only',
      );
      return null;
    }
    if (ageH > 5) {
      // Within 5–12 h: log only, no Telegram alert
      logger.debug(
        { ageH: Math.round(ageH) },
        'Burlak mildly stale, within log-only window',
      );
      return null;
    }
    return null;
  } catch {
    // Status file doesn't exist yet — no alert until first run completes
    return null;
  }
}

const EMAIL_TOKEN_CHECK_FILE = '/tmp/email-token-check.json';

/** Check Gmail send token validity — runs python3 send_email.py --check hourly via temp file */
function checkEmailToken(): string | null {
  const CONE_SCRIPTS = path.join(HOME, 'Develop/nano-cone/cone/scripts');
  const sendScript = path.join(CONE_SCRIPTS, 'send_email.py');

  try {
    const raw = fs.readFileSync(EMAIL_TOKEN_CHECK_FILE, 'utf-8');
    const result = JSON.parse(raw) as { ok: boolean; ts: string; err?: string };
    const ageMs = Date.now() - new Date(result.ts).getTime();

    // Re-run check if result is older than 1 hour
    if (ageMs > 60 * 60 * 1000) {
      spawnCheck();
    }

    if (!result.ok) {
      return `🔐 Gmail send token expiroval — spusť: python3 cone/scripts/auth_google.py`;
    }
    return null;
  } catch {
    // No result file yet — bootstrap the check
    spawnCheck();
    return null;
  }

  function spawnCheck() {
    try {
      execSync(
        `(python3 ${sendScript} --check > /dev/null 2>&1 && echo '{"ok":true,"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ${EMAIL_TOKEN_CHECK_FILE} || echo '{"ok":false,"ts":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > ${EMAIL_TOKEN_CHECK_FILE}) &`,
        { shell: '/bin/bash' },
      );
    } catch {
      /* best-effort */
    }
  }
}

/** Check email freshness — newest email should be < 6 hours old for primary account */
function checkEmailFreshness(): string | null {
  try {
    const logPath = path.join(CONE_LOGS, 'email_sync.log');
    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.split('\n');
    // Find the last "newest:" line for obluk.com (primary account)
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = lines[i].match(
        /obluk\.com:.*newest:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/,
      );
      if (match) {
        const age = Date.now() - new Date(match[1]).getTime();
        const ageHours = age / (60 * 60 * 1000);
        if (ageHours > 6) {
          return `⚠️ Email sync zastaralý: newest obluk.com email ${Math.round(ageHours)}h starý`;
        }
        return null;
      }
    }
  } catch {
    /* skip */
  }
  return null;
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
    backupNasWarnings: backup.nasWarnings,
    backupB2AgeDays: backup.b2Days,
    backupB2Warnings: backup.b2Warnings,
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

  const burlakHealth = checkBurlakHealth();
  if (burlakHealth) {
    alerts.push(burlakHealth);
  }

  const emailFreshness = checkEmailFreshness();
  if (emailFreshness) {
    alerts.push({ key: 'email-freshness', msg: emailFreshness });
  }

  const emailToken = checkEmailToken();
  if (emailToken) {
    alerts.push({ key: 'email-token', msg: emailToken });
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

  if (m.backupNasWarnings.length > 0) {
    alerts.push({
      key: 'backup-nas-warn',
      msg: `⚠️ NAS backup varování: ${m.backupNasWarnings.join('; ')}`,
    });
  }

  if (m.backupB2AgeDays > 8) {
    alerts.push({
      key: 'backup-b2',
      msg: `⚠️ B2 backup ${m.backupB2AgeDays} dní starý`,
    });
  }

  if (m.backupB2Warnings.length > 0) {
    alerts.push({
      key: 'backup-b2-warn',
      msg: `⚠️ B2 backup varování: ${m.backupB2Warnings.join('; ')}`,
    });
  }

  // Ollama: track consecutive OK checks, only alert after stable period
  if (m.ollamaUp) {
    state.ollamaConsecutiveOk++;
    if (
      !state.ollamaAlertEnabled &&
      state.ollamaConsecutiveOk >= OLLAMA_STABLE_THRESHOLD
    ) {
      state.ollamaAlertEnabled = true;
      logger.info(
        { consecutiveOk: state.ollamaConsecutiveOk },
        'Ollama stable — alerts enabled',
      );
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
  NAS: last success ${latest.backupNasAgeDays} days ago ${latest.backupNasAgeDays > 7 ? '⚠️ CRITICAL' : ''}${latest.backupNasWarnings.length > 0 ? ' — WARNINGS: ' + latest.backupNasWarnings.join('; ') : ''}
  B2: last success ${latest.backupB2AgeDays} days ago ${latest.backupB2AgeDays > 7 ? '⚠️' : ''}${latest.backupB2Warnings.length > 0 ? ' — WARNINGS: ' + latest.backupB2Warnings.join('; ') : ''}

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
      messages: [
        {
          role: 'system',
          content:
            'You are a system health analyst. Analyze metrics, detect anomalies, score health 1-10. Output ONLY valid JSON, no explanation.',
        },
        { role: 'user', content: prompt },
      ],
      think: false,
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
          `${OLLAMA_URL}/api/chat`,
          '-H',
          'Content-Type: application/json',
          '-d',
          `@${tmpPayload}`,
        ],
        { timeout: 65_000, encoding: 'utf8' },
      );
      const data = JSON.parse(stdout) as { message?: { content?: string } };
      return data.message?.content?.trim() || null;
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

function addAlertLog(msg: string): void {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
  state.alertLog.push({ ts, msg });
  // Keep max 20 entries
  if (state.alertLog.length > 20) state.alertLog.shift();
}

function addOrUpdateActionItem(alertKey: string, alertMsg: string): void {
  const mapping = ALERT_ACTION_MAP[alertKey];
  if (!mapping) return;

  // Don't add if already exists and unresolved
  const existing = state.actionItems.find(
    (a) => a.key === alertKey && !a.resolved,
  );
  if (existing) return;

  // Track first time this key fired — persists across resolve/re-trigger cycles within an episode
  // Episode resets if key was resolved and stayed clear for > 6h
  const now = Date.now();
  const lastResolved = state.keyLastResolvedAt[alertKey] ?? 0;
  const episodeExpired =
    lastResolved > 0 && now - lastResolved > 6 * 60 * 60 * 1000;
  if (!(alertKey in state.keyFirstActiveAt) || episodeExpired) {
    state.keyFirstActiveAt[alertKey] = now;
    delete state.keyTelegramSent[alertKey]; // new episode = can escalate again
  }

  // If Telegram was already sent for this key in the current episode, don't re-escalate
  const telegramAlreadySent =
    alertKey in state.keyTelegramSent && !episodeExpired;

  state.actionItems.push({
    assignee: mapping.assignee,
    key: alertKey,
    description: `${alertMsg} — ${mapping.action}`,
    created: new Date().toISOString().replace('T', ' ').slice(0, 16),
    telegramSent: telegramAlreadySent,
  });
}

function resolveActionItem(alertKey: string, by = 'monitor', note = ''): void {
  for (const item of state.actionItems) {
    if (item.key === alertKey && !item.resolved) {
      item.resolved = new Date().toISOString().replace('T', ' ').slice(0, 16);
      item.resolvedBy = by;
      item.resolvedNote = note;
    }
  }
  state.keyLastResolvedAt[alertKey] = Date.now();
}

/**
 * Read and process claims/resolves from agents.
 * Agents write to action_claims.json, monitor reads and applies.
 * File is truncated after processing.
 */
function processActionClaims(): void {
  try {
    if (!fs.existsSync(ACTION_CLAIMS_PATH)) return;
    const raw = fs.readFileSync(ACTION_CLAIMS_PATH, 'utf8').trim();
    if (!raw || raw === '[]') return;

    const claims: {
      key: string;
      action: 'claim' | 'resolve';
      by: string;
      note?: string;
    }[] = JSON.parse(raw);

    for (const claim of claims) {
      const item = state.actionItems.find(
        (a) => a.key === claim.key && !a.resolved,
      );
      if (!item) continue;

      if (claim.action === 'claim') {
        item.claimedBy = claim.by;
        item.claimedAt = new Date()
          .toISOString()
          .replace('T', ' ')
          .slice(0, 16);
        logger.info({ key: claim.key, by: claim.by }, 'Action item claimed');
      } else if (claim.action === 'resolve') {
        item.resolved = new Date().toISOString().replace('T', ' ').slice(0, 16);
        item.resolvedBy = claim.by;
        item.resolvedNote = claim.note || '';
        logger.info(
          { key: claim.key, by: claim.by, note: claim.note },
          'Action item resolved',
        );
      }
    }

    // Truncate after processing
    fs.writeFileSync(ACTION_CLAIMS_PATH, '[]');
  } catch (err) {
    logger.warn({ err }, 'Failed to process action claims');
  }
}

function writeHealthReport(metrics: MetricsSnapshot): void {
  try {
    const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
    let report = `# System Health\n\n> Single source of truth. Updated every 5 min. Last: ${now}.\n> Agents: check Action Items for your assignee (@agent, @cli, @karel).\n\n`;

    // ── Current State ──
    report += `## Stav\n\n`;
    report += `| Metrika | Hodnota | Status |\n|---------|---------|--------|\n`;
    report += `| Disk | ${metrics.diskUsedPct}% (${metrics.diskFreeGB}GB free) | ${metrics.diskUsedPct > 90 ? '⚠️' : '✅'} |\n`;
    report += `| cone.db | ${metrics.coneDbSizeMB} MB | ✅ |\n`;
    report += `| NanoClaw RAM | ${metrics.processMemMB} MB | ${metrics.processMemMB > 1000 ? '⚠️' : '✅'} |\n`;
    report += `| Ollama | ${metrics.ollamaUp ? 'up' : 'DOWN'} | ${metrics.ollamaUp ? '✅' : '❌'} |\n`;
    report += `| Backup NAS | ${metrics.backupNasAgeDays >= 0 ? metrics.backupNasAgeDays + ' days ago' : 'unknown'} | ${metrics.backupNasAgeDays > 3 ? '⚠️' : metrics.backupNasAgeDays >= 0 ? '✅' : '❓'} |\n`;
    report += `| Backup B2 | ${metrics.backupB2AgeDays >= 0 ? metrics.backupB2AgeDays + ' days ago' : 'unknown'} | ${metrics.backupB2AgeDays > 8 ? '⚠️' : metrics.backupB2AgeDays >= 0 ? '✅' : '❓'} |\n`;
    report += `| DB Lock | ${metrics.dbLocked ? 'YES' : 'no'} | ${metrics.dbLocked ? '⚠️' : '✅'} |\n`;
    report += `| Errors (24h) | ${metrics.errors.length} | ${metrics.errors.length > 0 ? '⚠️' : '✅'} |\n`;

    // ── Backup Details ──
    report += `\n## Backup Details\n\n`;
    report += `**NAS:** poslední úspěch ${metrics.backupNasAgeDays >= 0 ? metrics.backupNasAgeDays + ' dní' : 'neznámo'}`;
    if (metrics.backupNasWarnings.length > 0) {
      report += `, varování: ${metrics.backupNasWarnings.join('; ')}`;
    }
    report += `\n**B2:** poslední úspěch ${metrics.backupB2AgeDays >= 0 ? metrics.backupB2AgeDays + ' dní' : 'neznámo'}`;
    if (metrics.backupB2Warnings.length > 0) {
      report += `, varování: ${metrics.backupB2Warnings.join('; ')}`;
    }
    report += '\n';

    // ── Recent Alerts ──
    report += `\n## Recent Alerts\n\n`;
    if (state.alertLog.length > 0) {
      report += `| Čas | Alert |\n|-----|-------|\n`;
      for (const entry of [...state.alertLog].reverse()) {
        report += `| ${entry.ts} | ${entry.msg} |\n`;
      }
    } else {
      report += `Žádné alerty.\n`;
    }

    // ── Action Items ──
    report += `\n## Action Items\n\n`;
    report += `<!-- Stavy: [ ] open, [~] in progress, [x] resolved -->\n`;
    report += `<!-- Claim/resolve: zapsat do tracking/action_claims.json -->\n`;
    report += `<!-- Formát: [{"key":"alert-key","action":"claim|resolve","by":"CLI","note":"..."}] -->\n`;
    const openItems = state.actionItems.filter(
      (a) => !a.resolved && !a.claimedBy,
    );
    const inProgressItems = state.actionItems.filter(
      (a) => !a.resolved && a.claimedBy,
    );
    const recentResolved = state.actionItems
      .filter((a) => a.resolved)
      .slice(-5);
    if (
      openItems.length === 0 &&
      inProgressItems.length === 0 &&
      recentResolved.length === 0
    ) {
      report += `Žádné action items.\n`;
    } else {
      for (const item of openItems) {
        report += `- [ ] ${item.assignee} [key:${item.key}]: ${item.description} (od ${item.created})\n`;
      }
      for (const item of inProgressItems) {
        report += `- [~] ${item.assignee} [key:${item.key}]: ${item.description} — řeší ${item.claimedBy} od ${item.claimedAt}\n`;
      }
      for (const item of recentResolved) {
        const note = item.resolvedNote ? `: ${item.resolvedNote}` : '';
        report += `- [x] ${item.assignee}: ${item.description} — VYŘEŠENO ${item.resolved} (${item.resolvedBy || '?'}${note})\n`;
      }
    }

    // ── Ollama Analysis ──
    if (state.lastOllamaAnalysis) {
      report += `\n## Ollama Analysis\n\n\`\`\`json\n${state.lastOllamaAnalysis}\n\`\`\`\n`;
    }

    // ── Recent Errors ──
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

      // Create action items for NEW alerts (don't send Telegram yet — grace period)
      if (newAlerts.length > 0) {
        for (const a of newAlerts) {
          addAlertLog(a.msg);
          addOrUpdateActionItem(a.key, a.msg);
        }
      }

      // Clear resolved alerts and auto-resolve action items
      for (const key of state.lastAlerts) {
        if (!currentKeys.has(key)) {
          state.lastAlerts.delete(key);
          resolveActionItem(key, 'auto', 'Alert cleared');
        }
      }
      for (const a of alerts) {
        state.lastAlerts.add(a.key);
      }

      // Process claims/resolves from agents before escalation check
      processActionClaims();

      // Escalate to Telegram: unclaimed items whose alert key has been active > 2 hours
      // Uses keyFirstActiveAt so resolve/re-trigger cycles don't reset the timer
      const ESCALATION_DELAY = 2 * 60 * 60 * 1000; // 2 hours
      const escalationCandidates = state.actionItems.filter(
        (item) =>
          !item.resolved &&
          !item.claimedBy &&
          !item.telegramSent &&
          Date.now() - (state.keyFirstActiveAt[item.key] ?? Date.now()) >
            ESCALATION_DELAY,
      );
      if (escalationCandidates.length > 0) {
        const msg = escalationCandidates
          .map((item) => item.description)
          .join('\n');
        await sendAlert(`*System Monitor — neřešené problémy*\n${msg}`);
        const today = new Date().toISOString().slice(0, 10);
        for (const item of escalationCandidates) {
          item.telegramSent = true;
          state.keyTelegramSent[item.key] = Date.now();
          // Write @cli task so CLI can investigate with Karel
          try {
            const taskPath = path.join(
              KNOWLEDGE_REPO_PATH,
              'tracking',
              'tasks',
              `cli-${item.key}-${today}.md`,
            );
            if (!fs.existsSync(taskPath)) {
              fs.writeFileSync(
                taskPath,
                `# @cli task: ${item.key} (${today})\n\n> Vygenerováno automaticky — background-monitor eskaloval na Telegram po 2h bez řešení.\n\n## Problém\n\n${item.description}\n\n## Akce\n\n- [ ] Diagnostikovat root cause\n- [ ] Opravit nebo navrhnout řešení Karlovi\n`,
              );
            }
          } catch (e) {
            logger.warn({ key: item.key, err: e }, 'Failed to write @cli task');
          }
        }
      }

      // Write health report on EVERY Tier 1 run (not just hourly)
      writeHealthReport(metrics);

      // Tier 2: Ollama analysis (every hour)
      const now = Date.now();
      if (now - state.lastTier2 >= TIER2_INTERVAL) {
        state.lastTier2 = now;
        const latestMetrics = state.metrics[state.metrics.length - 1];

        if (!latestMetrics?.ollamaUp) {
          logger.info('Skipping Tier 2 — Ollama not available');
        } else {
          logger.info('Running Tier 2 Ollama analysis');
        }

        const analysis = latestMetrics?.ollamaUp
          ? await runOllamaAnalysis(state.metrics)
          : null;
        state.lastOllamaAnalysis = analysis;
        // Health report already written above in Tier 1 — next Tier 1 will include new analysis

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

      // Research agent (12h normal, 10min retry when Moltbook down)
      const researchInterval =
        state.moltbookOk === false
          ? RESEARCH_RETRY_INTERVAL
          : RESEARCH_INTERVAL;
      if (now - state.lastResearch >= researchInterval) {
        state.lastResearch = now;
        try {
          const result = await runResearchAgent(
            state.moltbookOk === false ? undefined : sendAlert, // no Telegram on retries
          );
          const wasDown = state.moltbookOk === false;
          state.moltbookOk = result.moltbookOk;
          if (wasDown && result.moltbookOk) {
            logger.info('Research: Moltbook recovered — back to 12h interval');
          } else if (!result.moltbookOk) {
            logger.info('Research: Moltbook still down — retrying in 10min');
          }
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
