#!/bin/bash
# calendar_sync_safe.sh — opravená verze s file lockingem pro token.json
# Nahrazuje: /Users/karel/Develop/nano-cone/cone/scripts/calendar_sync.sh
# Úprava v plist: změnit ProgramArguments na tuto cestu

BASE=/Users/karel/Develop/nano-cone/cone
LOG="$BASE/logs/calendar_sync.log"
SCRIPTS="$BASE/scripts"
LOCK_FILE="$BASE/config/.token.lock"

export PATH="/Library/Frameworks/Python.framework/Versions/3.12/bin:/usr/local/bin:/usr/bin:/bin"

if [ -f "$BASE/config/.env" ]; then
    set -a
    source "$BASE/config/.env"
    set +a
fi

mkdir -p "$BASE/logs"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] calendar_sync start" >> "$LOG"

# Použij flock pro zamčení token.json přístupu
# 180s timeout aby čekal pokud email_sync nebo doc_sync právě refresh
{
    flock -w 180 200 || {
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] CHYBA: Nepodařilo se získat lock na token (timeout 180s)" >> "$LOG"
        exit 1
    }
    
    cd "$SCRIPTS"
    if python3 sync_calendar.py --days-back 7 --days-ahead 120 >> "$LOG" 2>&1; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] calendar_sync OK" >> "$LOG"
    else
        EXIT_CODE=$?
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] CHYBA: sync_calendar.py selhalo (exit $EXIT_CODE)" >> "$LOG"
        # Aktualizuj connector_state na error
        python3 - << PYEOF
import sqlite3, json
from pathlib import Path
DB = Path("$BASE") / "db" / "cone.db"
try:
    conn = sqlite3.connect(str(DB), timeout=10)
    conn.execute("""
        INSERT INTO connector_state (connector, last_run, status, meta)
        VALUES ('google_calendar', CURRENT_TIMESTAMP, 'error', '{"error": "sync failed"}')
        ON CONFLICT(connector) DO UPDATE SET last_run=CURRENT_TIMESTAMP, status='error', meta=excluded.meta
    """)
    conn.commit(); conn.close()
except: pass
PYEOF
    fi
} 200>"$LOCK_FILE"
