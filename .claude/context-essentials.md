# Context Essentials — CLI rychlý kontext

> Číst po compaction nebo na začátku session. Stručný souhrn toho nejdůležitějšího.

## Identita a projekt

- **CLI agent** v `/Users/karel/Develop/nano-cone/nanoclaw/`
- Třívrstvá architektura: Šiška (kontejner/Telegram) ↔ Burlak (headless host) ↔ CLI (interaktivní)
- Knowledge repo: `~/Develop/nano-cone/knowledge/` (sdíleno všemi agenty)

## Kritická pravidla

- **NIKDY** vinit síť nebo "intermittent issues" — vždy zjistit přesnou chybu
- **NIKDY** mergovat Burlakovy branches bez Karlova explicitního schválení
- **NIKDY** `rm -rf`, force push, reset --hard bez explicitního pokynu
- git push, launchctl, DB writes = HIGH-IMPACT → potvrdit s Karlem pokud nejasné

## Klíčové cesty

| Co | Kde |
|----|-----|
| System health | `~/Develop/nano-cone/knowledge/tracking/system_health.md` |
| Agent Log | `~/Develop/nano-cone/knowledge/situation.md` (dolní část) |
| Active session | `~/Develop/nano-cone/knowledge/active_session.md` |
| Action claims | `~/Develop/nano-cone/knowledge/tracking/action_claims.json` |
| System pulse | `~/.config/nanoclaw/system_pulse.json` |
| Health transitions | `~/Develop/nano-cone/cone/logs/health_pulse.log` |
| Nanoclaw log | `~/Develop/nano-cone/nanoclaw/logs/nanoclaw.log` |

## System Health — co dělat na startu session

1. Přečíst `system_health.md` → najít `@cli` action items
2. Přečíst `situation.md` Agent Log (posledních 25 řádků) → najít `@cli` tasky
3. Claimovat přes action_claims.json (ne přímou editací system_health.md — přepisuje se každých 5 min):
   ```bash
   echo '[{"key":"ollama","action":"claim","by":"CLI"}]' > ~/Develop/nano-cone/knowledge/tracking/action_claims.json
   ```
4. Po vyřešení: resolve přes action_claims.json
5. Logovat do Agent Log: `- [YYYY-MM-DD HH:MM CLI]: co bylo uděláno`

Eskalace na Telegram: **2 hodiny** bez claimbování.

## Health monitoring — rychlá diagnostika

```bash
# Aktuální stav všech checků
cat ~/.config/nanoclaw/system_pulse.json | python3 -m json.tool

# Přechody UP/DOWN
tail -20 ~/Develop/nano-cone/cone/logs/health_pulse.log

# Je health-monitor spuštěn?
launchctl list | grep health-monitor

# Chyby health-monitoru
cat /tmp/health-monitor-error.log
```

## CLAUDE.md integrity

```bash
EXPECTED=$(cat ~/.config/cli/claude_md.sha256)
ACTUAL=$(shasum -a 256 ~/Develop/nano-cone/nanoclaw/CLAUDE.md | cut -d' ' -f1)
[ "$EXPECTED" = "$ACTUAL" ] && echo "✅ OK" || echo "⚠️ CLAUDE.md ZMĚNĚN"
```

## Klíčové soubory kódu

| Soubor | Účel |
|--------|------|
| `src/index.ts` | Orchestrátor, píše `~/.config/nanoclaw/nanoclaw.pid` |
| `src/background-monitor.ts` | Tier 1 health checks (5 min) + Tier 2 Ollama analýza |
| `src/task-scheduler.ts` | Scheduled tasks |
| `src/container-runner.ts` | Spouštění agentů v kontejnerech |
