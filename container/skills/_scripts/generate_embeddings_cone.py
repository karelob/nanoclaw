"""
Embedding generace pro cone.db — spouští se z NanoClaw kontejneru.

Čte z: /workspace/extra/cone-db/cone.db (read-only)
Píše do: /workspace/extra/knowledge/embeddings.db (writable)
Přeskakuje: Evolution emaily (nesmí jít do cloudu)

Spuštění:
  python3 /home/node/.claude/scripts/generate_embeddings_cone.py --stats
  python3 /home/node/.claude/scripts/generate_embeddings_cone.py --limit 500   # test
  python3 /home/node/.claude/scripts/generate_embeddings_cone.py               # plný běh
"""

import argparse, os, sqlite3, struct, sys, time, hashlib
from pathlib import Path
from datetime import datetime

# ── Cesty ───────────────────────────────────────────
DB_PATH      = Path("/workspace/extra/cone-db/cone.db")
EMB_DB_PATH  = Path("/workspace/extra/knowledge/embeddings.db")
ENV_FILE     = Path("/workspace/extra/cone-config/.env")

# ── Config ───────────────────────────────────────────
EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIM   = 768
MAX_TEXT_CHARS  = 4000
BATCH_SIZE      = 250    # Gemini zvládne 100 per volání, pošleme 2-3 najednou
SLEEP_PER_CALL  = 0.2    # ~5 batch/s = 500 emails/s (Gemini limit ~1500 req/min)

# Evolution emaily NIKDY do cloudu
SKIP_ACCOUNTS = {"karel.obluk@evolutionequity.com", "karel@evolutionequity.com"}


def load_api_key():
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("GOOGLE_AI_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("GOOGLE_AI_API_KEY not found in .env")


def init_emb_db():
    conn = sqlite3.connect(str(EMB_DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS embeddings (
            id          INTEGER PRIMARY KEY,
            source_type TEXT NOT NULL,
            source_id   INTEGER NOT NULL,
            model       TEXT NOT NULL,
            vector      BLOB NOT NULL,
            text_hash   TEXT,
            created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(source_type, source_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_emb_source ON embeddings(source_type, source_id)")
    conn.commit()
    return conn


def vector_to_blob(values):
    return struct.pack(f"{len(values)}f", *values)


def prepare_email_text(row):
    parts = []
    if row["subject"]:
        parts.append(f"Subject: {row['subject']}")
    if row["from_addr"]:
        parts.append(f"From: {row['from_addr']}")
    if row["body"]:
        parts.append(row["body"][:3000])
    text = "\n".join(parts)
    return text[:MAX_TEXT_CHARS] if text.strip() else None


def get_pending_ids(cone_conn, emb_conn, limit=None):
    """Vrátí IDs emailů bez embeddingu, přeskočí Evolution účty."""
    done = set(r[0] for r in emb_conn.execute(
        "SELECT source_id FROM embeddings WHERE source_type='email'"
    ).fetchall())

    skip_placeholders = ",".join("?" * len(SKIP_ACCOUNTS))
    query = f"""
        SELECT id FROM emails
        WHERE body IS NOT NULL AND body != ''
        AND account_email NOT IN ({skip_placeholders})
        ORDER BY sent_at DESC
    """
    all_ids = [r[0] for r in cone_conn.execute(query, list(SKIP_ACCOUNTS)).fetchall()
               if r[0] not in done]

    if limit:
        return all_ids[:limit]
    return all_ids


def process(limit=None, batch_size=BATCH_SIZE):
    api_key = load_api_key()
    os.environ["GOOGLE_API_KEY"] = api_key

    from google import genai
    client = genai.Client()

    emb_conn = init_emb_db()
    cone_conn = sqlite3.connect(str(DB_PATH), timeout=30)
    cone_conn.row_factory = sqlite3.Row

    print(f"[{datetime.now():%H:%M:%S}] Načítám pending IDs...")
    pending = get_pending_ids(cone_conn, emb_conn, limit)
    total = len(pending)
    done_already = emb_conn.execute(
        "SELECT COUNT(*) FROM embeddings WHERE source_type='email'"
    ).fetchone()[0]

    print(f"Hotovo: {done_already} | Zbývá: {total} emailů (Evolution přeskočeno)")
    if not total:
        print("Vše hotovo.")
        emb_conn.close(); cone_conn.close()
        return

    processed = 0
    errors = 0
    start = time.time()

    for i in range(0, total, batch_size):
        batch_ids = pending[i:i + batch_size]
        ph = ",".join("?" * len(batch_ids))
        rows = cone_conn.execute(
            f"SELECT id, subject, from_addr, body FROM emails WHERE id IN ({ph})",
            batch_ids
        ).fetchall()

        texts, valid_rows = [], []
        for row in rows:
            t = prepare_email_text(row)
            if t:
                texts.append(t)
                valid_rows.append(row)

        if not texts:
            continue

        try:
            for sub_start in range(0, len(texts), 100):
                sub_texts = texts[sub_start:sub_start + 100]
                sub_rows  = valid_rows[sub_start:sub_start + 100]

                result = client.models.embed_content(
                    model=EMBEDDING_MODEL,
                    contents=sub_texts,
                    config={"output_dimensionality": EMBEDDING_DIM}
                )

                for row, emb in zip(sub_rows, result.embeddings):
                    emb_conn.execute(
                        "INSERT OR IGNORE INTO embeddings (source_type, source_id, model, vector) VALUES (?,?,?,?)",
                        ("email", row["id"], EMBEDDING_MODEL, vector_to_blob(emb.values))
                    )

                emb_conn.commit()
                processed += len(sub_texts)
                time.sleep(SLEEP_PER_CALL)

        except Exception as e:
            errors += 1
            print(f"  CHYBA batch {i}: {e}")
            if "429" in str(e) or "quota" in str(e).lower():
                print("  Rate limit — čekám 60s...")
                time.sleep(60)
            else:
                time.sleep(5)
            continue

        if processed % 2000 == 0 or i == 0:
            elapsed = time.time() - start
            rate = processed / elapsed if elapsed > 0 else 1
            eta_min = (total - processed) / rate / 60
            pct = processed * 100 // total
            print(f"  [{datetime.now():%H:%M:%S}] {processed}/{total} ({pct}%) | "
                  f"{rate:.0f} emails/s | ETA: {eta_min:.0f} min | chyby: {errors}")

    emb_conn.close()
    cone_conn.close()
    elapsed = time.time() - start
    print(f"\n[{datetime.now():%H:%M:%S}] Hotovo: {processed} embeddingů za {elapsed/60:.1f} min ({errors} chyb)")


def show_stats():
    cone_conn = sqlite3.connect(str(DB_PATH), timeout=30)
    skip_ph = ",".join("?" * len(SKIP_ACCOUNTS))

    total_safe = cone_conn.execute(
        f"SELECT COUNT(*) FROM emails WHERE body IS NOT NULL AND body != '' AND account_email NOT IN ({skip_ph})",
        list(SKIP_ACCOUNTS)
    ).fetchone()[0]
    total_evo = cone_conn.execute(
        f"SELECT COUNT(*) FROM emails WHERE account_email IN ({skip_ph})",
        list(SKIP_ACCOUNTS)
    ).fetchone()[0]
    cone_conn.close()

    if EMB_DB_PATH.exists():
        emb_conn = sqlite3.connect(str(EMB_DB_PATH))
        done = emb_conn.execute("SELECT COUNT(*) FROM embeddings WHERE source_type='email'").fetchone()[0]
        emb_conn.close()
        db_mb = EMB_DB_PATH.stat().st_size / 1024 / 1024
    else:
        done = 0
        db_mb = 0

    print(f"=== Embedding Stats ===")
    print(f"Emaily (bez Evolution): {total_safe}")
    print(f"Evolution (přeskočeno): {total_evo}")
    print(f"Embeddingy hotové:      {done} / {total_safe} ({done*100//max(total_safe,1)}%)")
    print(f"Zbývá:                  {total_safe - done}")
    print(f"Odhadovaný čas zbytku: ~{(total_safe - done) / 500 / 60:.0f} min při 500 emails/s")
    print(f"DB: {EMB_DB_PATH} ({db_mb:.1f} MB)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--stats", action="store_true")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    args = parser.parse_args()

    if args.stats:
        show_stats()
    else:
        process(limit=args.limit, batch_size=args.batch_size)
