# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/sprint` | Koordinovaný improvement sprint — review Burlak branches, implementace proposals |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## ZÁSADNÍ PRAVIDLA

**NIKDY nesvádět problémy na síť nebo "intermittent issues".** Když něco nefunguje:
1. Zjistit PŘESNOU chybu (stderr, exit code, HTTP status)
2. Ověřit z jiného kontextu (terminál vs launchd)
3. Diagnostikovat root cause — NIKDY "zkusím restart"
4. Karel toto zdůraznil opakovaně. Porušení = ztráta důvěry.

**Burlakovy branches NIKDY mergovat bez Karlova explicitního schválení.**

## Memory promotion rules

**DO — ukládat do `~/.claude/projects/.../memory/`:**
- Explicitní instrukce od Karla ("remember", "from now on", "vždy")
- Preference ověřené opakovanou zpětnou vazbou (ne jednorázové)
- Architektonická rozhodnutí ověřená v kódu nebo git historii

**DO NOT — ukládat do memory:**
- Inference a hypotézy ("Karel pravděpodobně preferuje X")
- Výsledky nebo stav jedné session bez Karlova potvrzení
- Cokoliv odvoditelné ze zdrojáku, git history nebo cone.db
- Ephemeral stav (co aktuálně běží, in-progress work)

## Tool risk tiers (CLI)

**READ-ONLY** (vždy OK): Read, Glob, Grep, Bash readonly, WebFetch/Search

**BOUNDED WRITE** (OK, verifikovat): Edit/Write souborů v repo, git commit

**HIGH-IMPACT** (potvrdit s Karlem pokud nejasné):
- git push, merge do main
- launchctl load/unload/kickstart
- Změny LaunchAgent plistů, scheduled tasks v DB
- sqlite3 write do cone.db

**NEVER bez explicitního pokynu:**
- `rm -rf`, force push, reset --hard
- Změny produkční konfigurace bez čtení aktuálního stavu

## Integrity check

Na začátku každé session ověř integritu tohoto souboru:

```bash
EXPECTED=$(cat ~/.config/cli/claude_md.sha256)
ACTUAL=$(shasum -a 256 ~/Develop/nano-cone/nanoclaw/CLAUDE.md | cut -d' ' -f1)
[ "$EXPECTED" = "$ACTUAL" ] && echo "✅ CLAUDE.md OK" || echo "⚠️ CLAUDE.md ZMĚNĚN — ověř s Karlem"
```

Po každé oprávněné změně CLAUDE.md aktualizuj hash:
```bash
shasum -a 256 ~/Develop/nano-cone/nanoclaw/CLAUDE.md | cut -d' ' -f1 > ~/.config/cli/claude_md.sha256
```

## Memory Discipline — Active Session Management

### File: `knowledge/active_session.md`
This is the **primary continuity mechanism** across compactions. It survives context loss because hooks reload it automatically.

### When to Update active_session.md
1. **After completing any task** — add results to Key Facts, update Open Threads
2. **After any decision** — add to Recent Decisions with rationale
3. **When Karel shares new info** — add to Key Facts with source
4. **When starting new topic** — add to Open Threads
5. **When resolving a thread** — move from Open Threads to situation.md Agent Log
6. **BEFORE saying "done"** — verify active_session.md reflects current state

### Size Discipline
- Max 50 lines. If growing beyond, archive older items:
  - Resolved threads → `situation.md` Agent Log
  - Old decisions → `learnings/decisions.md`
  - Old facts → appropriate knowledge/ file

### Post-Compaction Recovery (AUTOMATIC via hooks)
After compaction, hooks automatically inject:
1. `.claude/context-essentials.md` — rules, identity, paths
2. `knowledge/active_session.md` — current work context
3. Last 25 lines of `situation.md` — recent agent comms
4. Pending `@cli` items from `system_health.md`

**You do NOT need to manually re-read these files after compaction.**
**You DO need to keep active_session.md current so the hook has good data to inject.**

### Periodic Self-Check
Every ~10 interactions, verify:
- [ ] Is active_session.md up to date?
- [ ] Are there new facts that should be persisted?
- [ ] Are any Open Threads resolved but not moved?

## System Health — Action Items

`knowledge/tracking/system_health.md` is the **single source of truth** for system health. It is updated every 5 minutes by background-monitor and contains:
- Current metrics (sync, backup, disk, Ollama)
- Recent alerts (what was sent to Telegram)
- **Action Items** with assignees (`@agent`, `@cli`, `@karel`)

**CLI sessions MUST:**
1. Read `system_health.md` at session start — check for `@cli` action items, fix proactively
2. Read `situation.md` Agent Log — check for `@cli` tasks from other agents
3. If Agent Log references `tracking/tasks/*.md` for CLI — read and execute
4. Re-read when Karel says "zkontroluj" / "podívej se na stav" / "check"
5. Claim items: `- [ ]` → `- [~] ... řeší CLI od {date}` (prevents Telegram escalation)
6. After fix: `- [~]` → `- [x] VYŘEŠENO {date} (CLI: what was done)`
7. Log own actions to Agent Log: `- [date CLI]: what was done`
8. Unclaimed health items escalate to Karel's Telegram after 15 minutes

Path: `~/Develop/nano-cone/knowledge/tracking/system_health.md`

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

