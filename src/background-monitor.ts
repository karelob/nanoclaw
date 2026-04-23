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
import { execFileSync, execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { KNOWLEDGE_REPO_PATH, STORE_DIR } from './config.js';
import { logger } from './logger.js';
import { runResearchAgent } from './research-agent.js';
import { checkDbLock, SYNC_JOBS, checkJob } from './sync-health.js';

const RESEARCH_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
const RESEARCH_RETRY_INTERVAL = 10 * 60 * 1000; // 10 min retry when Moltbook is down

// ── Config ──────────────────────────────────────────
const HOME = process.env.HOME || '/Users/karel';
const CONE_DB = path.join(HOME, 'Develop/nano-cone/cone/db/cone.db');
const CONE_LOGS = path.join(HOME, 'Develop/nano-cone/cone/logs');
const OLLAMA_URL = process.env.OLLAMA_HOST || 'http://10.0.10.70:11434';
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
    assignee: '@cli',
    action: 'Diagnostikovat DB lock (cone.db), zabít blokující proces',
  },
  'email-sync-stale': {
    assignee: '@agent',
    action:
      'Zkontrolovat email sync log, zkusit opravit. Pokud nelze: vytvořit @cli task',
  },
  'calendar-sync-stale': {
    assignee: '@agent',
    action:
      'Zkontrolovat calendar sync log, zkusit opravit. Pokud nelze: vytvořit @cli task',
  },
  'nanoclaw-down': {
    assignee: '@cli',
    action:
      'Diagnostikovat NanoClaw (pidfile/process), restartovat launchd service',
  },
  'burlak-stale': {
    assignee: '@cli',
    action: 'Zkontrolovat Burlak logy, diagnostikovat proč neběžel',
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
  'graph-sync-stale': {
    assignee: '@cli',
    action:
      'Zkontrolovat ~/Library/Logs/cone/graph-sync.log, spustit graph_sync.sh ručně',
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
  // Own checks (not in pulse)
  dbLocked: boolean;
  dbLockMsg: string | undefined;
  diskFreeGB: number;
  diskUsedPct: number;
  coneDbSizeMB: number;
  processMemMB: number;
  errors: string[];
  // From system_pulse.json (health-monitor binary)
  pulseAvailable: boolean;
  ollamaUp: boolean;
  backupNasOk: boolean;
  backupNasAgeH: number;
  backupB2Ok: boolean;
  backupB2AgeH: number;
  emailSyncOk: boolean;
  emailSyncAgeMin: number;
  calendarSyncOk: boolean;
  calendarSyncAgeMin: number;
  burlakOk: boolean;
  burlakAgeH: number;
  burlakLastStatus: string;
  nanoclawOk: boolean;
  nanoclawError: string;
  graphSyncOk: boolean;
  graphSyncAgeH: number;
  graphSyncLastStatus: string;
}

// Ollama must be up N consecutive checks before we trust it enough to alert on failures
const OLLAMA_STABLE_THRESHOLD = 12; // 12 × 5min = 1 hour of consecutive OK
// Ollama must be down N consecutive checks before we alert (avoids flapping false alarms)
const OLLAMA_DOWN_THRESHOLD = 3; // 3 × 5min = 15 min of consecutive DOWN

const state: MonitorState & {
  lastResearch: number;
  moltbookOk: boolean | undefined;
  ollamaConsecutiveOk: number;
  ollamaConsecutiveDown: number;
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
  ollamaConsecutiveDown: 0,
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

const SYSTEM_PULSE_PATH = path.join(HOME, '.config/nanoclaw/system_pulse.json');
const MONITOR_STATE_PATH = path.join(
  HOME,
  '.config/nanoclaw/monitor_state.json',
);

interface SystemPulseCheck {
  ok: boolean;
  latency_ms?: number;
  age_h?: number;
  age_min?: number;
  last_status?: string;
  error?: string;
}
interface SystemPulse {
  checked_at: string;
  checks: Record<string, SystemPulseCheck>;
}

// Read the JSON status file written by health-monitor (launchd every 5 min).
// Returns null if the file is missing or stale (>12 min) — caller falls back to direct curl.
function readSystemPulse(): SystemPulse | null {
  try {
    const raw = fs.readFileSync(SYSTEM_PULSE_PATH, 'utf-8');
    const pulse = JSON.parse(raw) as SystemPulse;
    const ageMs = Date.now() - new Date(pulse.checked_at).getTime();
    if (ageMs > 12 * 60 * 1000) return null; // stale
    return pulse;
  } catch {
    return null;
  }
}

// Direct Ollama check via curl — fallback when pulse is stale/unavailable.
function checkOllamaDirectly(): boolean {
  try {
    const result = spawnSync(
      '/usr/bin/curl',
      [
        '-s',
        '--connect-timeout',
        '5',
        '--max-time',
        '8',
        `${OLLAMA_URL}/api/tags`,
      ],
      { timeout: 10000 },
    );
    return result.status === 0 && result.stdout.length > 0;
  } catch {
    return false;
  }
}

// ── Monitor state persistence ────────────────────────

interface PersistedMonitorState {
  ollamaConsecutiveOk: number;
  ollamaConsecutiveDown: number;
  ollamaAlertEnabled: boolean;
  savedAt: string;
}

function saveMonitorState(): void {
  try {
    const s: PersistedMonitorState = {
      ollamaConsecutiveOk: state.ollamaConsecutiveOk,
      ollamaConsecutiveDown: state.ollamaConsecutiveDown,
      ollamaAlertEnabled: state.ollamaAlertEnabled,
      savedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(MONITOR_STATE_PATH), { recursive: true });
    fs.writeFileSync(MONITOR_STATE_PATH, JSON.stringify(s, null, 2));
  } catch {
    /* non-critical */
  }
}

function loadMonitorState(): void {
  try {
    const raw = fs.readFileSync(MONITOR_STATE_PATH, 'utf-8');
    const s = JSON.parse(raw) as PersistedMonitorState;
    const ageMs = Date.now() - new Date(s.savedAt).getTime();
    if (ageMs > 15 * 60 * 1000) {
      logger.info('Monitor state stale (>15 min) — starting fresh');
      return;
    }
    state.ollamaConsecutiveOk = s.ollamaConsecutiveOk;
    state.ollamaConsecutiveDown = s.ollamaConsecutiveDown;
    state.ollamaAlertEnabled = s.ollamaAlertEnabled;
    logger.info(
      {
        alertEnabled: s.ollamaAlertEnabled,
        ok: s.ollamaConsecutiveOk,
        down: s.ollamaConsecutiveDown,
      },
      'Restored monitor state',
    );
  } catch {
    /* first run or missing file — start fresh */
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
        if (pattern.test(line)) {
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

function collectMetrics(): MetricsSnapshot {
  const disk = checkDiskSpace();
  const dbLockMsg = checkDbLock() ?? undefined;
  const pulse = readSystemPulse();
  const ollamaUp = pulse
    ? (pulse.checks['ollama']?.ok ?? false)
    : checkOllamaDirectly();

  return {
    ts: new Date().toISOString(),
    // Own checks
    dbLocked: dbLockMsg !== undefined,
    dbLockMsg,
    diskFreeGB: disk.freeGB,
    diskUsedPct: disk.usedPct,
    coneDbSizeMB: checkConeDbSize(),
    processMemMB: checkProcessHealth(),
    errors: getRecentErrors(),
    // From pulse
    pulseAvailable: pulse !== null,
    ollamaUp,
    backupNasOk: pulse?.checks['backup_nas']?.ok ?? true,
    backupNasAgeH: pulse?.checks['backup_nas']?.age_h ?? -1,
    backupB2Ok: pulse?.checks['backup_b2']?.ok ?? true,
    backupB2AgeH: pulse?.checks['backup_b2']?.age_h ?? -1,
    emailSyncOk: pulse?.checks['email_sync']?.ok ?? true,
    emailSyncAgeMin: pulse?.checks['email_sync']?.age_min ?? 0,
    calendarSyncOk: pulse?.checks['calendar_sync']?.ok ?? true,
    calendarSyncAgeMin: pulse?.checks['calendar_sync']?.age_min ?? 0,
    burlakOk: pulse?.checks['burlak']?.ok ?? true,
    burlakAgeH: pulse?.checks['burlak']?.age_h ?? 0,
    burlakLastStatus: pulse?.checks['burlak']?.last_status ?? 'unknown',
    nanoclawOk: pulse?.checks['nanoclaw']?.ok ?? true,
    nanoclawError: pulse?.checks['nanoclaw']?.error ?? '',
    graphSyncOk: pulse?.checks['graph_sync']?.ok ?? true,
    graphSyncAgeH: pulse?.checks['graph_sync']?.age_h ?? -1,
    graphSyncLastStatus: pulse?.checks['graph_sync']?.last_status ?? 'unknown',
  };
}

// ── Alert with state change detection ───────────────

function generateAlerts(m: MetricsSnapshot): { key: string; msg: string }[] {
  const alerts: { key: string; msg: string }[] = [];

  // DB lock (own check — not in pulse)
  if (m.dbLocked && m.dbLockMsg) {
    alerts.push({ key: 'sync', msg: m.dbLockMsg });
  }

  // Disk (own check)
  if (m.diskUsedPct > 90) {
    alerts.push({
      key: 'disk',
      msg: `⚠️ Disk ${m.diskUsedPct}% full (${m.diskFreeGB}GB free)`,
    });
  }

  // Memory (own check)
  if (m.processMemMB > 1000) {
    alerts.push({ key: 'memory', msg: `⚠️ NanoClaw ${m.processMemMB}MB RAM` });
  }

  // Email token (own check)
  const emailToken = checkEmailToken();
  if (emailToken) {
    alerts.push({ key: 'email-token', msg: emailToken });
  }

  // Pulse-based checks (skip if pulse unavailable to avoid false alarms)
  if (m.pulseAvailable) {
    // NanoClaw health
    if (!m.nanoclawOk) {
      alerts.push({
        key: 'nanoclaw-down',
        msg: `⚠️ NanoClaw health check FAIL: ${m.nanoclawError}`,
      });
    }

    // Burlak staleness — two thresholds: >5h log-only, >12h alert
    if (m.burlakAgeH > 12) {
      alerts.push({
        key: 'burlak-stale',
        msg: `⚠️ Burlak neběžel ${Math.round(m.burlakAgeH)}h (očekáváno každé 4h)`,
      });
    } else if (m.burlakAgeH > 5) {
      logger.debug(
        { ageH: Math.round(m.burlakAgeH) },
        'Burlak mildly stale, within log-only window',
      );
    }

    // Email sync freshness (threshold: 6h = 360 min)
    if (!m.emailSyncOk || m.emailSyncAgeMin > 360) {
      alerts.push({
        key: 'email-sync-stale',
        msg: `⚠️ Email sync zastaralý: ${Math.round(m.emailSyncAgeMin)} min`,
      });
    }

    // Calendar sync freshness (threshold: 6h)
    if (!m.calendarSyncOk || m.calendarSyncAgeMin > 360) {
      alerts.push({
        key: 'calendar-sync-stale',
        msg: `⚠️ Calendar sync zastaralý: ${Math.round(m.calendarSyncAgeMin)} min`,
      });
    }

    // Backup NAS (threshold: 3 days = 72h)
    const nasAgeDays = m.backupNasAgeH / 24;
    if (!m.backupNasOk || nasAgeDays > 3) {
      alerts.push({
        key: 'backup-nas',
        msg: `⚠️ NAS backup ${Math.round(nasAgeDays)} dní starý`,
      });
    }

    // Backup B2 (threshold: 8 days = 192h)
    const b2AgeDays = m.backupB2AgeH / 24;
    if (!m.backupB2Ok || b2AgeDays > 8) {
      alerts.push({
        key: 'backup-b2',
        msg: `⚠️ B2 backup ${Math.round(b2AgeDays)} dní starý`,
      });
    }

    // Graph sync (threshold: 36h — runs nightly 03:30, alert if missed 1.5 days)
    if (m.graphSyncAgeH >= 0 && (!m.graphSyncOk || m.graphSyncAgeH > 36)) {
      alerts.push({
        key: 'graph-sync-stale',
        msg: `⚠️ Graph sync neběžel ${Math.round(m.graphSyncAgeH)}h (status: ${m.graphSyncLastStatus})`,
      });
    }
  }

  // Ollama: track consecutive OK/DOWN checks.
  // Only enable alerts after 1h of stability (avoids false alarms at startup).
  // Only fire alert after 3 consecutive DOWN checks (~15 min) to avoid flapping.
  if (m.ollamaUp) {
    state.ollamaConsecutiveDown = 0;
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
    state.ollamaConsecutiveDown++;
    if (
      state.ollamaAlertEnabled &&
      state.ollamaConsecutiveDown >= OLLAMA_DOWN_THRESHOLD
    ) {
      alerts.push({
        key: 'ollama',
        msg: `⚠️ Ollama nedostupný (10.0.10.70) — ${state.ollamaConsecutiveDown * 5} min`,
      });
    }
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

  const nasAgeDays =
    latest.backupNasAgeH >= 0 ? Math.round(latest.backupNasAgeH / 24) : -1;
  const b2AgeDays =
    latest.backupB2AgeH >= 0 ? Math.round(latest.backupB2AgeH / 24) : -1;
  const graphSyncAgeH =
    latest.graphSyncAgeH >= 0 ? Math.round(latest.graphSyncAgeH) : -1;

  const prompt = `System health snapshot (${latest.ts}):

SYNC_JOBS:
${syncSummary}

SERVICES:
  NanoClaw: ${latest.nanoclawOk ? 'ok' : 'FAIL' + (latest.nanoclawError ? ' — ' + latest.nanoclawError : '')}
  Ollama: ${latest.ollamaUp ? 'up' : 'DOWN'}
  Burlak: last run ${Math.round(latest.burlakAgeH)}h ago (${latest.burlakLastStatus})
  Email sync: ${Math.round(latest.emailSyncAgeMin)} min ago${latest.emailSyncOk ? '' : ' ⚠️'}
  Calendar sync: ${Math.round(latest.calendarSyncAgeMin)} min ago${latest.calendarSyncOk ? '' : ' ⚠️'}

DB: cone.db ${latest.coneDbSizeMB}MB, locked=${latest.dbLocked}
DISK: ${latest.diskUsedPct}% used, ${latest.diskFreeGB}GB free
MEMORY: NanoClaw ${latest.processMemMB}MB RSS

BACKUP:
  NAS: last success ${nasAgeDays >= 0 ? nasAgeDays + ' days ago' : 'unknown'}${nasAgeDays > 7 ? ' ⚠️ CRITICAL' : ''}
  B2: last success ${b2AgeDays >= 0 ? b2AgeDays + ' days ago' : 'unknown'}${b2AgeDays > 7 ? ' ⚠️' : ''}
  Graph sync: ${graphSyncAgeH >= 0 ? graphSyncAgeH + 'h ago (' + latest.graphSyncLastStatus + ')' : 'never run'}${graphSyncAgeH > 36 ? ' ⚠️' : ''}

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
    const pulseTag = metrics.pulseAvailable ? '' : ' ⚠️ pulse stale';
    let report = `# System Health\n\n> Single source of truth. Updated every 5 min. Last: ${now}${pulseTag}.\n> Agents: check Action Items for your assignee (@agent, @cli, @karel).\n\n`;

    // ── Current State ──
    const nasAgeDays =
      metrics.backupNasAgeH >= 0 ? Math.round(metrics.backupNasAgeH / 24) : -1;
    const b2AgeDays =
      metrics.backupB2AgeH >= 0 ? Math.round(metrics.backupB2AgeH / 24) : -1;
    report += `## Stav\n\n`;
    report += `| Metrika | Hodnota | Status |\n|---------|---------|--------|\n`;
    report += `| Disk | ${metrics.diskUsedPct}% (${metrics.diskFreeGB}GB free) | ${metrics.diskUsedPct > 90 ? '⚠️' : '✅'} |\n`;
    report += `| cone.db | ${metrics.coneDbSizeMB} MB | ✅ |\n`;
    report += `| NanoClaw | ${metrics.nanoclawOk ? 'OK' : 'FAIL'} | ${metrics.nanoclawOk ? '✅' : '❌'} |\n`;
    report += `| NanoClaw RAM | ${metrics.processMemMB} MB | ${metrics.processMemMB > 1000 ? '⚠️' : '✅'} |\n`;
    report += `| Ollama | ${metrics.ollamaUp ? 'up' : 'DOWN'} | ${metrics.ollamaUp ? '✅' : '❌'} |\n`;
    report += `| Burlak | ${metrics.burlakAgeH >= 0 ? Math.round(metrics.burlakAgeH) + 'h ago' : 'unknown'} | ${metrics.burlakAgeH > 12 ? '⚠️' : metrics.burlakAgeH > 5 ? '🟡' : '✅'} |\n`;
    report += `| Graph sync | ${metrics.graphSyncAgeH >= 0 ? Math.round(metrics.graphSyncAgeH) + 'h ago' : 'never'} | ${metrics.graphSyncAgeH < 0 ? '❓' : !metrics.graphSyncOk || metrics.graphSyncAgeH > 36 ? '⚠️' : '✅'} |\n`;
    report += `| Email sync | ${metrics.emailSyncAgeMin > 0 ? Math.round(metrics.emailSyncAgeMin) + ' min ago' : 'unknown'} | ${!metrics.emailSyncOk || metrics.emailSyncAgeMin > 360 ? '⚠️' : '✅'} |\n`;
    report += `| Calendar sync | ${metrics.calendarSyncAgeMin > 0 ? Math.round(metrics.calendarSyncAgeMin) + ' min ago' : 'unknown'} | ${!metrics.calendarSyncOk || metrics.calendarSyncAgeMin > 360 ? '⚠️' : '✅'} |\n`;
    report += `| Backup NAS | ${nasAgeDays >= 0 ? nasAgeDays + ' days ago' : 'unknown'} | ${nasAgeDays > 3 ? '⚠️' : nasAgeDays >= 0 ? '✅' : '❓'} |\n`;
    report += `| Backup B2 | ${b2AgeDays >= 0 ? b2AgeDays + ' days ago' : 'unknown'} | ${b2AgeDays > 8 ? '⚠️' : b2AgeDays >= 0 ? '✅' : '❓'} |\n`;
    report += `| DB Lock | ${metrics.dbLocked ? 'YES' : 'no'} | ${metrics.dbLocked ? '⚠️' : '✅'} |\n`;
    report += `| Errors (24h) | ${metrics.errors.length} | ${metrics.errors.length > 0 ? '⚠️' : '✅'} |\n`;

    // ── Backup Details ──
    report += `\n## Backup Details\n\n`;
    report += `**NAS:** poslední úspěch ${nasAgeDays >= 0 ? nasAgeDays + ' dní' : 'neznámo'}\n`;
    report += `**B2:** poslední úspěch ${b2AgeDays >= 0 ? b2AgeDays + ' dní' : 'neznámo'}\n`;

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
  loadMonitorState();

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
      // lastTier2 is only updated when Tier 2 actually runs — if Ollama is down,
      // we retry on every Tier 1 cycle (every 5 min) until it recovers.
      const now = Date.now();
      if (now - state.lastTier2 >= TIER2_INTERVAL) {
        const latestMetrics = state.metrics[state.metrics.length - 1];

        if (!latestMetrics?.ollamaUp) {
          logger.info(
            'Skipping Tier 2 — Ollama not available (will retry in 5 min)',
          );
        } else {
          state.lastTier2 = now;
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
      saveMonitorState();
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
