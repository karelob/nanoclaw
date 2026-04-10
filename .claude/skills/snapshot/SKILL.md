# Snapshot — System status export for external review

Generuje kompletní snapshot stavu systému pro review v Claude.ai session.
Výstup: jeden soubor `/tmp/system_snapshot_YYYY-MM-DD.md` připravený k uploadu.

## Kdy použít
Karel řekne "snapshot", "/snapshot", "připrav snapshot", "potřebuji snapshot pro Claude".

## Steps

### 1. Vygeneruj snapshot

Vytvoř soubor `/tmp/system_snapshot_$(date +%Y-%m-%d).md` s následujícím obsahem:

```markdown
# System Snapshot [YYYY-MM-DD HH:MM CET]

## 1. Active Session Context
```
Vlož celý obsah `knowledge/active_session.md`.

```markdown
## 2. Improvement Pipeline Status

### Signals (last 15)
```
Vlož posledních 15 signálů z `knowledge/tracking/improvement_signals.md`.

```markdown
### Proposals
```
Vlož celý obsah `knowledge/tracking/improvement_proposals.md`.

```markdown
### Today's Briefing Nudge
```
Vlož obsah `knowledge/tracking/briefing_improvement_nudge.md`.

```markdown
## 3. Burlak Activity (last 48h)

### Agent Log (last 30 lines)
```
Vlož výstup: `tail -30 knowledge/situation.md`

```markdown
### Burlak Branches (open)
```
Vlož výstup: `git branch -a | grep burlak/`

```markdown
### Last 3 Burlak Run Logs (summaries)
```
Pro poslední 3 log soubory v `burlak/logs/` vlož posledních 20 řádků každého.

```markdown
## 4. System Health
```
Vlož celý obsah `knowledge/tracking/system_health.md`.

```markdown
## 5. Scheduled Tasks Status

### NanoClaw Tasks (last runs)
```
Vlož výstup:
```bash
sqlite3 store/messages.db "SELECT task_id, last_run_at, last_status FROM scheduled_tasks ORDER BY last_run_at DESC"
```

```markdown
### LaunchAgent Status
```
Vlož výstup: `launchctl list | grep -E "cone|nanoclaw|burlak"`

```markdown
## 6. Knowledge Repo Metrics
```
Vlož výstup:
```bash
echo "=== File counts ==="
find ~/Develop/nano-cone/knowledge -name "*.md" | wc -l
echo "=== Total size ==="
du -sh ~/Develop/nano-cone/knowledge/
echo "=== Recently modified (last 48h) ==="
find ~/Develop/nano-cone/knowledge -name "*.md" -mtime -2 -exec ls -la {} \;
echo "=== Claude project memory files ==="
ls ~/.claude/projects/-Users-karel-Develop-nano-cone-nanoclaw/memory/ | wc -l
du -sh ~/.claude/projects/-Users-karel-Develop-nano-cone-nanoclaw/memory/
```

```markdown
## 7. Hook Status

### Post-compaction hook
```
Vlož výstup: `cat .claude/hooks/post-compact.sh | head -5` (ověření existence)

```markdown
### Settings.json hooks
```
Vlož výstup: `cat .claude/settings.json | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('hooks',{}), indent=2))"` nebo `jq '.hooks' .claude/settings.json`

```markdown
## 8. Context Essentials
```
Vlož celý obsah `.claude/context-essentials.md`.

```markdown
## 9. Cone DB Quick Stats
```
Vlož výstup:
```bash
sqlite3 ~/Develop/nano-cone/cone/db/cone.db "
SELECT 'emails' as tbl, COUNT(*) as cnt FROM emails
UNION ALL SELECT 'entities', COUNT(*) FROM entities
UNION ALL SELECT 'facts', COUNT(*) FROM facts
UNION ALL SELECT 'documents', COUNT(*) FROM documents
UNION ALL SELECT 'events', COUNT(*) FROM events
UNION ALL SELECT 'commitments (open)', COUNT(*) FROM commitments WHERE status='open'
UNION ALL SELECT 'cone_inbox (7d)', COUNT(*) FROM cone_inbox WHERE created_at > datetime('now', '-7 days')
"
```

```markdown
## 10. Open Questions / Issues

### From improvements.md (last 10 entries)
```
Vlož posledních 10 záznamů z `knowledge/tracking/improvements.md`.

```markdown
### From open_items.md
```
Vlož celý obsah `knowledge/tracking/open_items.md` (pokud existuje).

```markdown
---
*Snapshot generated [timestamp]. Sensitive data excluded. For Claude.ai review session.*
```

### 2. Ověř a informuj

Po vygenerování:
1. Ověř velikost: `wc -l /tmp/system_snapshot_*.md` — pokud > 500 řádků, upozorni Karla
2. Zkontroluj, že neobsahuje API klíče nebo citlivá data: `grep -i "key\|token\|password\|secret" /tmp/system_snapshot_*.md`
3. Řekni Karlovi: "Snapshot ready: /tmp/system_snapshot_YYYY-MM-DD.md ([N] řádků). Nahraj ho do Claude.ai session."

### 3. Zapiš do active_session.md

Přidej do Open Threads: "Snapshot vygenerován pro Claude.ai review [datum]"
