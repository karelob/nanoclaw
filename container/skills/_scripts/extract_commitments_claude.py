#!/usr/bin/env python3
"""
extract_commitments_claude.py — Claude-based commitment extraction

Reads recent emails from cone.db, extracts commitments using Claude API.
Writes to: cone.db commitments table + tracking/open_items.md

Usage:
  python3 extract_commitments_claude.py [hours]   # default 25h
  python3 extract_commitments_claude.py --test     # dry run, no writes
"""

import sqlite3
import json
import sys
import os
from datetime import datetime, timedelta
from pathlib import Path
import re
import json
import urllib.request

CONE_DB = "/workspace/local-db/cone.db"
KNOWLEDGE_DIR = "/workspace/extra/knowledge"
OPEN_ITEMS = f"{KNOWLEDGE_DIR}/tracking/open_items.md"

# Meeting URLs → commitment je pravděpodobně kalendářová událost
MEETING_URL_RE = re.compile(
    r"meet\.google\.com|teams\.microsoft\.com|zoom\.us|webex\.com|whereby\.com|gotomeeting\.com"
)

# Evolution = citlivá data, NESMÍ do cloudu (Ollama = lokální, OK)
SKIP_ACCOUNTS = {"karel.obluk@evolutionequity.com"}

# Lokální Ollama (RTX 4070 Ti Super, zdarma)
OLLAMA_URL = "http://10.0.10.70:11434/api/chat"
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen3.5:9b")

# Zdroj pro dedup
SOURCE_RUN = "ollama_nanoclaw"


def normalize_subject(subject: str) -> str:
    """Normalize subject for thread grouping."""
    s = (subject or "").lower()
    for prefix in ["re:", "fwd:", "fw:", "res:", "sv:", "odpověď:"]:
        while s.startswith(prefix):
            s = s[len(prefix):].strip()
    return s.strip()


def get_recent_emails(hours: int = 25) -> list[dict]:
    """Get recent non-Evolution emails, grouped by thread."""
    import shutil
    tmp_db = "/tmp/cone_commitments_read.db"
    shutil.copy(CONE_DB, tmp_db)
    conn = sqlite3.connect(tmp_db)
    conn.row_factory = sqlite3.Row

    cutoff = (datetime.now() - timedelta(hours=hours)).isoformat()
    placeholders = ",".join("?" * len(SKIP_ACCOUNTS))

    rows = conn.execute(
        f"""
        SELECT id, message_id, from_addr, to_addrs, subject, sent_at,
               SUBSTR(body, 1, 1200) AS body_preview, account_email
        FROM emails
        WHERE sent_at > ?
          AND account_email NOT IN ({placeholders})
          AND body IS NOT NULL
          AND LENGTH(body) > 60
        ORDER BY sent_at ASC
        """,
        [cutoff] + list(SKIP_ACCOUNTS),
    ).fetchall()
    conn.close()

    # Group by normalized subject
    threads: dict[str, list] = {}
    for row in rows:
        key = normalize_subject(row["subject"])
        if key not in threads:
            threads[key] = []
        threads[key].append(dict(row))

    return list(threads.values())


SYSTEM_PROMPT = """Jsi asistent extrahující závazky z emailů Karla Obluka (CEO, investor, Brno).

Extrahuj VŠECHNY závazky — explicitní i implicitní:
- SENT = Karel něco slíbil: "pošlu", "ozvu se", "připravím", "zavolám", "podívám se", "zajistím", "domluvím"...
- RECEIVED = někdo slíbil Karlovi: "pošleme", "připravím pro vás", "dám vědět", "zašlu podklady"...

Pravidla:
1. description = KONKRÉTNÍ akce (NE jen subject emailu). Příklad: "Zaslat Lucii intro na Petra" místo "RE: Intro"
2. counterparty = celé jméno nebo firma (podle emailu/kontextu)
3. due_date = ISO datum pokud zmíněno, jinak null
4. confidence: high = explicitní slib, medium = jasný implicitní, low = možná/spekulativní
5. Vrať POUZE JSON array, žádný text navíc

Formát každého závazku:
{
  "direction": "sent" | "received",
  "counterparty": "Jméno nebo firma",
  "description": "Konkrétní akce — co, komu, jak",
  "due_date": "YYYY-MM-DD" | null,
  "confidence": "high" | "medium" | "low",
  "thread_subject": "předmět emailového vlákna"
}

Pokud žádné závazky nejsou, vrať: []"""


def call_ollama(prompt: str) -> str:
    """Call local Ollama API (chat endpoint for thinking mode support)."""
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "user", "content": prompt},
        ],
        "think": False,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 800},
    }).encode()
    req = urllib.request.Request(
        OLLAMA_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read())
    return data.get("message", {}).get("content", "")


def extract_with_claude(threads: list[list[dict]], api_key: str = "", dry_run: bool = False) -> list[dict]:
    """Extract commitments from email threads using Ollama (local LLM)."""
    if dry_run:
        print("[DRY RUN] Skipping Ollama call")
        return []

    all_commitments = []

    for emails in threads:
        subject = emails[0].get("subject", "")
        thread_text = ""
        for email in emails[:4]:
            body = (email.get("body_preview") or "").strip()
            thread_text += (
                f"Od: {email['from_addr']}\n"
                f"Komu: {email['to_addrs']}\n"
                f"Datum: {email['sent_at']}\n"
                f"Předmět: {email['subject']}\n\n"
                f"{body[:800]}\n"
                f"---\n"
            )

        if len(thread_text) < 80:
            continue

        full_prompt = f"{SYSTEM_PROMPT}\n\nExtrahuj závazky:\n\n{thread_text}\n\nVrať POUZE JSON array:"

        try:
            text = call_ollama(full_prompt).strip()

            # Parse JSON array from response
            match = re.search(r"\[.*?\]", text, re.DOTALL)
            if match:
                commitments = json.loads(match.group())
                for c in commitments:
                    if not c.get("thread_subject"):
                        c["thread_subject"] = subject
                all_commitments.extend(commitments)
            # Empty array is valid — no commitments in this thread

        except Exception as e:
            print(f"  Warning: thread '{subject[:50]}' failed: {e}", file=sys.stderr)

    return all_commitments


_CAL_STOP = {
    "bude", "nebo", "jako", "jsou", "jsme", "bylo", "byla", "bych", "jeho",
    "send", "from", "that", "this", "with", "please", "will", "have",
    "karel", "obluk", "email", "call", "meeting", "schůzka", "setkání",
}


def has_matching_calendar_event(conn, description: str, due_date) -> bool:
    """Vrátí True pokud commitment pravděpodobně odpovídá kalendářové události.

    Kritéria:
    1. Description obsahuje video/meeting URL → skoro jistě event
    2. OR due_date odpovídá eventu s překrývajícími klíčovými slovy
    """
    desc_lower = (description or "").lower()
    has_url = bool(MEETING_URL_RE.search(desc_lower))

    if not due_date and not has_url:
        return False

    if due_date:
        date_from = date_to = due_date
    else:
        today = datetime.now().strftime("%Y-%m-%d")
        date_from = today
        date_to = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d")

    try:
        rows = conn.execute("""
            SELECT summary FROM events
            WHERE DATE(start_dt) BETWEEN DATE(?, '-1 day') AND DATE(?, '+1 day')
              AND (status IS NULL OR LOWER(status) != 'cancelled')
            LIMIT 30
        """, (date_from, date_to)).fetchall()
    except Exception:
        return False

    if not rows:
        return False

    # Meeting URL + event na stejný den → skip
    if has_url:
        return True

    # Bez URL: jen pokud se klíčová slova překrývají
    desc_words = {w for w in re.findall(r"[a-záčďéěíňóřšťúůýž]{4,}", desc_lower)
                  if w not in _CAL_STOP}
    for (summary,) in rows:
        ev_words = {w for w in re.findall(r"[a-záčďéěíňóřšťúůýž]{4,}", (summary or "").lower())
                    if w not in _CAL_STOP}
        if desc_words & ev_words:
            return True

    return False


def save_to_db(commitments: list[dict], dry_run: bool = False) -> int:
    """Save commitments to cone.db, skip duplicates."""
    if dry_run:
        for c in commitments:
            if c.get("confidence") != "low":
                print(f"  [DRY RUN DB] {c.get('direction','?')} | {c.get('counterparty','?')} | {c.get('description','?')[:80]}")
        return 0

    conn = sqlite3.connect(CONE_DB, timeout=30)
    inserted = 0
    now = datetime.now().isoformat()

    for c in commitments:
        if not c.get("description") or c.get("confidence") == "low":
            continue

        # Dedup: same subject + direction + counterparty and not done/irrelevant
        existing = conn.execute(
            """
            SELECT id FROM commitments
            WHERE thread_subject = ? AND direction = ? AND counterparty = ?
              AND status NOT IN ('done', 'irrelevant')
            """,
            (c.get("thread_subject", ""), c.get("direction", ""), c.get("counterparty", "")),
        ).fetchone()

        if existing:
            continue

        # Přeskočit commitments, které jsou ve skutečnosti kalendářové události
        if has_matching_calendar_event(conn, c.get("description", ""), c.get("due_date")):
            print(f"  [CALENDAR SKIP] {c.get('description','')[:80]}")
            continue

        desc = re.sub(r'\*\*([^*]+)\*\*', r'\1', c.get("description", ""))
        desc = re.sub(r'\*([^*]+)\*', r'\1', desc).strip()
        conn.execute(
            """
            INSERT INTO commitments
              (thread_subject, direction, description, counterparty, due_date, status, source_run, created_at)
            VALUES (?, ?, ?, ?, ?, 'open', ?, ?)
            """,
            (
                c.get("thread_subject", "")[:300],
                c.get("direction", "sent"),
                desc[:500],
                c.get("counterparty", "")[:200],
                c.get("due_date"),
                SOURCE_RUN,
                now,
            ),
        )
        inserted += 1

    conn.commit()
    conn.close()
    return inserted


def append_to_open_items(commitments: list[dict], dry_run: bool = False) -> int:
    """Append new high/medium confidence commitments to open_items.md."""
    new_items = [
        c for c in commitments
        if c.get("confidence") in ("high", "medium") and c.get("description")
    ]
    if not new_items:
        return 0

    today = datetime.now().strftime("%Y-%m-%d")
    lines = [f"\n### Závazky {today} (Claude extrakce)\n"]

    for c in new_items:
        arrow = "→ Karel" if c.get("direction") == "sent" else "← Přijato"
        due = f" (do {c['due_date']})" if c.get("due_date") else ""
        person = c.get("counterparty", "")
        desc = c.get("description", "")
        lines.append(f"- [ ] [{arrow}] {desc}{due} — {person}")

    block = "\n".join(lines) + "\n"

    if dry_run:
        print(f"[DRY RUN open_items] Would append:\n{block}")
        return len(new_items)

    with open(OPEN_ITEMS, "a", encoding="utf-8") as f:
        f.write(block)

    return len(new_items)


def main():
    dry_run = "--test" in sys.argv
    hours = 25
    for arg in sys.argv[1:]:
        if arg.isdigit():
            hours = int(arg)

    print(f"=== Commitments extraction (Ollama/{OLLAMA_MODEL}) — last {hours}h ===")

    threads = get_recent_emails(hours)
    email_count = sum(len(t) for t in threads)
    print(f"Threads: {len(threads)}, Emails: {email_count}")

    if not threads:
        print("No emails to process.")
        return

    commitments = extract_with_claude(threads, dry_run=dry_run)
    total = len(commitments)
    high_med = [c for c in commitments if c.get("confidence") in ("high", "medium")]
    print(f"Extracted: {total} commitments ({len(high_med)} high/medium confidence)")

    db_count = save_to_db(commitments, dry_run=dry_run)
    items_count = append_to_open_items(commitments, dry_run=dry_run)

    print(f"Saved: {db_count} to DB, {items_count} to open_items.md")

    if dry_run:
        print("\n--- All extracted ---")
        for c in commitments:
            print(f"  [{c.get('confidence','?')}] {c.get('direction','?')} | {c.get('counterparty','?')} | {c.get('description','?')[:80]}")


if __name__ == "__main__":
    main()
