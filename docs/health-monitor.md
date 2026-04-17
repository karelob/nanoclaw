# health-monitor

NanoClaw uses [health-monitor](https://github.com/karelob/health-monitor) — a standalone Swift CLI binary — to run periodic health checks and write a JSON status file that background-monitor.ts reads.

## Why

The previous approach used a blocking `spawnSync` curl call inside background-monitor.ts every 5 minutes, with no state persistence across restarts. health-monitor replaces this with:

- A launchd-managed native binary that runs independently of NanoClaw
- Configurable check types with per-check intervals
- A JSON status file consumed by background-monitor.ts
- A transition log for UP/DOWN state changes
- Visible by name in macOS System Settings → Privacy & Security (code-signed)

## Paths (NanoClaw-specific)

| Item | Path |
|------|------|
| Config | `~/.config/health-monitor/config.json` |
| Status file | `~/.config/nanoclaw/system_pulse.json` |
| Transition log | `~/Develop/nano-cone/cone/logs/health_pulse.log` |
| Binary | `~/.local/bin/health-monitor` |
| State | `~/.config/health-monitor/pulse_state.json` |
| LaunchAgent | `~/Library/LaunchAgents/com.cone.health-monitor.plist` |

The config and status file are **not in git** — they are local to this machine.

## Checks configured

| Name | Type | Interval | What it checks |
|------|------|----------|---------------|
| `ollama` | `http_ping` | 5 min | Ollama at `http://10.0.10.70:11434/api/tags` |
| `nanoclaw` | `pid_alive` | 5 min | NanoClaw process via `~/.config/nanoclaw/nanoclaw.pid` |
| `burlak` | `status_file` | 1 hr | `~/.config/burlak/last_run.json` (max 12h old) |
| `email_sync` | `log_fresh` | 30 min | `cone/logs/email_sync.log` (max 90 min old) |
| `calendar_sync` | `log_fresh` | 30 min | `cone/logs/calendar_sync.log` (max 30 min old) |
| `backup_b2` | `log_fresh` | 12 hr | `cone/logs/backup.log` matching `B2.*OK` (max 7 days) |
| `backup_nas` | `log_fresh` | 12 hr | `cone/logs/backup.log` matching `NAS.*OK` (max 2 days) |

## How background-monitor reads it

`src/background-monitor.ts` reads `system_pulse.json` in `checkOllama()`. If the file is missing or older than 12 minutes (i.e. health-monitor is not running), it falls back to a direct curl call.

The NanoClaw process writes its PID to `~/.config/nanoclaw/nanoclaw.pid` at startup (`src/index.ts`), enabling the `pid_alive` check.

## Reading system_pulse.json from agents

```typescript
const pulse = JSON.parse(fs.readFileSync('~/.config/nanoclaw/system_pulse.json', 'utf-8'));
// pulse.checked_at — ISO timestamp of last check run
// pulse.checks['ollama'].ok — boolean
// pulse.checks['ollama'].latency_ms — number (http_ping only)
// pulse.checks['burlak'].age_h — hours since last run
```

## Rebuild and reinstall

```bash
cd ~/Develop/health-monitor
swift build -c release
cp .build/release/health-monitor ~/.local/bin/health-monitor
codesign --sign "Apple Development: Karel Obluk (64P4U97YMT)" \
         --options runtime ~/.local/bin/health-monitor
launchctl kickstart -k gui/$(id -u)/com.cone.health-monitor
```
