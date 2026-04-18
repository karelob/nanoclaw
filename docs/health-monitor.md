# health-monitor — system health monitoring

NanoClaw uses [health-monitor](https://github.com/karelob/health-monitor) — a standalone Swift CLI binary managed by launchd — to run periodic health checks and write a JSON status file that `background-monitor.ts` reads.

---

## Why a separate process

The previous approach ran a blocking `spawnSync` curl call inside `background-monitor.ts` every 5 minutes. Problems:

- **Single check, hardcoded**: only Ollama, nothing else
- **Blocking**: stalled the Node.js event loop for up to 10 seconds on timeout
- **No state persistence**: Ollama UP/DOWN counters reset on every NanoClaw restart, causing the 1-hour stability window to restart from scratch
- **Not identifiable**: appeared as `sh` or `node` in macOS Security & Privacy

health-monitor solves all of this:

- **Configurable checks** — add, remove, and tune checks via JSON, no code changes
- **Per-check intervals** — HTTP pings every 5 min; backup freshness once every 12 hours
- **Independent process** — runs even when NanoClaw is down; launchd restarts it if it crashes
- **State persistence** — `pulse_state.json` survives process restarts; intervals are respected across reboots
- **Native binary** — appears by name in macOS System Settings → Privacy & Security

---

## Architecture

```
launchd (every 5 min)
  └─ health-monitor binary (~/.local/bin/health-monitor)
       ├─ reads  ~/.config/health-monitor/config.json
       ├─ reads  ~/.config/health-monitor/pulse_state.json   (last-run timestamps)
       ├─ runs due checks concurrently
       ├─ detects transitions → appends to cone/logs/health_pulse.log
       ├─ writes ~/.config/nanoclaw/system_pulse.json         (results for all checks)
       └─ writes ~/.config/health-monitor/pulse_state.json   (updated timestamps)

NanoClaw (Node.js, every 5 min via background-monitor.ts)
  └─ reads  ~/.config/nanoclaw/system_pulse.json
       ├─ if file < 12 min old → use pulse data
       └─ if missing / stale  → fall back to direct curl (health-monitor not running)

NanoClaw startup (src/index.ts)
  └─ writes ~/.config/nanoclaw/nanoclaw.pid   (for pid_alive check)
```

---

## File paths

| Item | Path | In git? |
|------|------|---------|
| Binary | `~/.local/bin/health-monitor` | no |
| Config | `~/.config/health-monitor/config.json` | no (machine-specific) |
| Status file | `~/.config/nanoclaw/system_pulse.json` | no |
| Transition log | `~/Develop/nano-cone/cone/logs/health_pulse.log` | no |
| State | `~/.config/health-monitor/pulse_state.json` | no |
| LaunchAgent | `~/Library/LaunchAgents/com.cone.health-monitor.plist` | no |
| NanoClaw PID | `~/.config/nanoclaw/nanoclaw.pid` | no |
| Source | `~/Develop/health-monitor/` | separate repo |

---

## Configured checks

| Name | Type | Interval | Threshold | What it checks |
|------|------|----------|-----------|---------------|
| `ollama` | `http_ping` | 5 min | timeout 6 s | Ollama at `http://10.0.10.70:11434/api/tags` |
| `nanoclaw` | `pid_alive` | 5 min | — | NanoClaw process via `~/.config/nanoclaw/nanoclaw.pid` |
| `burlak` | `status_file` | 1 hr | max 12 h old | `~/.config/burlak/last_run.json` |
| `email_sync` | `log_fresh` | 30 min | max 90 min old | `cone/logs/email_sync.log` |
| `calendar_sync` | `log_fresh` | 30 min | max 30 min old | `cone/logs/calendar_sync.log` |
| `backup_b2` | `log_fresh` | 12 hr | max 168 h (7 d) | `cone/logs/backup.log` matching `B2.*OK` |
| `backup_nas` | `log_fresh` | 12 hr | max 48 h (2 d) | `cone/logs/backup.log` matching `NAS.*OK` |

Rationale:
- Ollama and NanoClaw are cheap to check (HTTP + pidfile) — every 5 min is safe
- Email and calendar sync should produce output at least hourly — 90 / 30 min thresholds catch a missed run early
- Backup checks are expensive to run and backup itself is weekly — 12 hr check interval, generous thresholds

---

## How background-monitor.ts reads the pulse file

`src/background-monitor.ts:collectMetrics()` reads `system_pulse.json` once per Tier 1 cycle and maps all service checks into `MetricsSnapshot`. If the file is missing or older than 12 minutes, `pulseAvailable` is `false` and pulse-based alerts are suppressed to avoid false alarms. Ollama additionally falls back to a direct `curl` call when pulse is unavailable.

```typescript
// background-monitor.ts — simplified
function collectMetrics(): MetricsSnapshot {
  const pulse = readSystemPulse();          // null if missing or stale (> 12 min)
  const ollamaUp = pulse
    ? (pulse.checks['ollama']?.ok ?? false)
    : checkOllamaDirectly();               // curl fallback only for Ollama

  return {
    // Own checks — not in pulse
    dbLocked: ..., diskFreeGB: ..., coneDbSizeMB: ..., processMemMB: ..., errors: ...,
    // From pulse
    pulseAvailable: pulse !== null,
    ollamaUp,
    nanoclawOk:        pulse?.checks['nanoclaw']?.ok ?? true,
    burlakOk:          pulse?.checks['burlak']?.ok ?? true,
    burlakAgeH:        pulse?.checks['burlak']?.age_h ?? 0,
    emailSyncOk:       pulse?.checks['email_sync']?.ok ?? true,
    emailSyncAgeMin:   pulse?.checks['email_sync']?.age_min ?? 0,
    calendarSyncOk:    pulse?.checks['calendar_sync']?.ok ?? true,
    backupNasOk:       pulse?.checks['backup_nas']?.ok ?? true,
    backupNasAgeH:     pulse?.checks['backup_nas']?.age_h ?? -1,
    backupB2Ok:        pulse?.checks['backup_b2']?.ok ?? true,
    backupB2AgeH:      pulse?.checks['backup_b2']?.age_h ?? -1,
  };
}
```

**Separation of concerns:**

| Source | Metrics |
|--------|---------|
| `system_pulse.json` (health-monitor) | ollama, nanoclaw, burlak, email_sync, calendar_sync, backup_nas, backup_b2 |
| background-monitor own checks | disk space, cone.db size, NanoClaw RAM, DB lock (lsof), error log scan |

The 12-minute staleness threshold is generous — health-monitor runs every 5 minutes, so up to two launchd invocations can miss before background-monitor marks pulse unavailable. This handles brief macOS sleep/wake cycles.

---

## State persistence in background-monitor

The Ollama stability counters (`ollamaConsecutiveOk`, `ollamaConsecutiveDown`, `ollamaAlertEnabled`) are persisted to `~/.config/nanoclaw/monitor_state.json` at the end of each Tier 1 cycle and loaded at startup. This prevents the 1-hour stability window from restarting every time NanoClaw is restarted or updated.

The state is discarded if it's more than 15 minutes old (indicating a longer outage — fresh start is appropriate).

---

## NanoClaw PID file

`src/index.ts` writes `~/.config/nanoclaw/nanoclaw.pid` after signal handlers are set up:

```typescript
const pidFile = path.join(HOME, '.config/nanoclaw/nanoclaw.pid');
fs.writeFileSync(pidFile, String(process.pid));
```

This enables the `pid_alive` check in health-monitor to verify NanoClaw is running. The file is not cleaned up on exit (health-monitor's pidfile check is robust to stale PIDs — `kill(pid, 0)` returns ESRCH if the PID is no longer alive).

**Note:** The PID file is written by new code added in commit `682f4d1`. NanoClaw must be restarted once for the `nanoclaw` check to show `ok: true`.

---

## Reading system_pulse.json from agents or scripts

```typescript
// TypeScript
interface PulseCheck {
  ok: boolean;
  checked_at: string;   // ISO 8601
  latency_ms?: number;  // http_ping only
  pid?: number;         // pid_alive only
  age_h?: number;       // log_fresh / status_file
  age_min?: number;     // log_fresh (when max_age_min is configured)
  last_status?: string; // status_file only
  error?: string;       // failure reason when ok=false
}
interface SystemPulse {
  checked_at: string;
  checks: Record<string, PulseCheck>;
}

const pulse: SystemPulse = JSON.parse(
  fs.readFileSync(path.join(HOME, '.config/nanoclaw/system_pulse.json'), 'utf-8')
);
pulse.checks['ollama'].ok          // → true/false
pulse.checks['ollama'].latency_ms  // → 42 (ms)
pulse.checks['burlak'].age_h       // → 2.1 (hours since last run)
```

```bash
# Shell / Python quick check
python3 -c "
import json, sys
p = json.load(open('$HOME/.config/nanoclaw/system_pulse.json'))
print(p['checked_at'])
for k, v in p['checks'].items():
    print(f\"  {k}: {'OK' if v['ok'] else 'FAIL'}\")
"
```

---

## Rebuild and reinstall

```bash
cd ~/Develop/health-monitor
swift build -c release
cp .build/release/health-monitor ~/.local/bin/health-monitor
codesign --sign "Apple Development: Karel Obluk (64P4U97YMT)" \
         --options runtime ~/.local/bin/health-monitor
launchctl kickstart -k gui/$(id -u)/com.cone.health-monitor
```

Verify:
```bash
~/.local/bin/health-monitor --version
launchctl list | grep health-monitor
cat ~/.config/nanoclaw/system_pulse.json | python3 -m json.tool
```

---

## Troubleshooting

**`system_pulse.json` missing or always stale**

```bash
launchctl list | grep health-monitor       # should show PID (non-zero)
cat /tmp/health-monitor-error.log          # stderr from last run
~/.local/bin/health-monitor --once         # run manually to see errors inline
```

**`nanoclaw` check always FAIL**

NanoClaw was started before the PID file code was deployed. Restart NanoClaw:
```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

**`backup_b2` / `backup_nas` FAIL after adding a new check**

health-monitor's state file may have stale entries from a previous test config. Run `--once` to force all checks:
```bash
~/.local/bin/health-monitor --once
```

**background-monitor is using curl instead of the pulse file**

Means the pulse file is older than 12 minutes. Check if health-monitor is running:
```bash
launchctl list com.cone.health-monitor
```
If PID is `0`, launchd ran it and it exited with an error. Check `/tmp/health-monitor-error.log`.
