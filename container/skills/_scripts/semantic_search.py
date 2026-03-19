"""
Sémantické vyhledávání v emailech přes embeddingy.

Použití:
  python3 semantic_search.py "emaily o nájemném Baker" --top 10
  python3 semantic_search.py "investment term sheet" --top 5 --since 2025-01-01
"""

import argparse, os, sqlite3, struct, sys, time
from pathlib import Path

DB_PATH     = Path("/workspace/extra/cone-db/cone.db")
EMB_DB_PATH = Path("/workspace/extra/cone-db/embeddings.db")
ENV_FILE    = Path("/workspace/extra/cone-config/.env")

EMBEDDING_MODEL = "gemini-embedding-001"
EMBEDDING_DIM   = 768
CHUNK_SIZE      = 20000   # načítej po 20K vektorech


def load_api_key():
    for line in ENV_FILE.read_text().splitlines():
        if line.startswith("GOOGLE_AI_API_KEY="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("GOOGLE_AI_API_KEY not in .env")


def get_query_embedding(query: str) -> list:
    api_key = load_api_key()
    os.environ["GOOGLE_API_KEY"] = api_key
    from google import genai
    client = genai.Client()
    result = client.models.embed_content(
        model=EMBEDDING_MODEL,
        contents=[query],
        config={"output_dimensionality": EMBEDDING_DIM}
    )
    return result.embeddings[0].values


def blob_to_vec(blob):
    n = len(blob) // 4
    return struct.unpack(f"{n}f", blob)


def cosine_sim_batch_numpy(query_vec, matrix):
    """Cosine similarity: query_vec (1×D) vs matrix (N×D) — numpy rychlá verze."""
    import numpy as np
    q = np.array(query_vec, dtype=np.float32)
    q_norm = q / (np.linalg.norm(q) + 1e-10)
    norms = np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-10
    m_norm = matrix / norms
    return (m_norm @ q_norm).tolist()


def cosine_sim_batch(query_vec, blob_list):
    """Vrátí cosine similarity query_vec vs každý blob v listu."""
    try:
        import numpy as np
        matrix = np.frombuffer(b"".join(blob_list), dtype=np.float32).reshape(len(blob_list), -1)
        return cosine_sim_batch_numpy(query_vec, matrix)
    except ImportError:
        import struct, math
        qmag = math.sqrt(sum(x*x for x in query_vec))
        results = []
        for blob in blob_list:
            v = struct.unpack(f"{len(blob)//4}f", blob)
            dot = sum(a*b for a, b in zip(query_vec, v))
            vmag = math.sqrt(sum(x*x for x in v))
            sim = dot / (qmag * vmag) if qmag * vmag > 0 else 0
            results.append(sim)
        return results


def search(query: str, top_k: int = 10, since: str = None,
           skip_evolution: bool = True) -> list:
    """
    Hledá emaily semanticky podobné dotazu.
    Vrátí list [(score, email_id, subject, from_addr, sent_at, snippet)]
    """
    t0 = time.time()
    print(f"Generuji embedding pro: '{query}'...")
    qvec = get_query_embedding(query)

    # Kopie DBs do /tmp (sqlite3 potřebuje write pro WAL)
    import shutil, tempfile
    tmp_emb = "/tmp/emb_search.db"
    tmp_cone = "/tmp/cone_search.db"
    shutil.copy(str(EMB_DB_PATH), tmp_emb)
    shutil.copy(str(DB_PATH), tmp_cone)

    emb_conn = sqlite3.connect(tmp_emb, timeout=30)
    cone_conn = sqlite3.connect(tmp_cone, timeout=30)
    cone_conn.row_factory = sqlite3.Row

    # Filtr dle data
    date_filter = ""
    if since:
        date_filter = f"AND e.sent_at >= '{since}'"

    # Filtr Evolution
    evo_filter = ""
    if skip_evolution:
        evo_filter = "AND e.account_email NOT IN ('karel.obluk@evolutionequity.com','karel@evolutionequity.com')"

    # Načítej embeddingy po chunkách a hledej top-K
    top_results = []  # (score, source_id)

    print(f"Prohledávám embeddingy...")
    total_checked = 0

    for offset in range(0, 300000, CHUNK_SIZE):
        rows = emb_conn.execute(
            "SELECT source_id, vector FROM embeddings WHERE source_type='email' LIMIT ? OFFSET ?",
            (CHUNK_SIZE, offset)
        ).fetchall()

        if not rows:
            break

        ids   = [r[0] for r in rows]
        blobs = [r[1] for r in rows]
        sims  = cosine_sim_batch(qvec, blobs)

        for sid, sim in zip(ids, sims):
            top_results.append((sim, sid))

        total_checked += len(rows)
        # Ořež na top 200 průběžně
        if len(top_results) > 500:
            top_results.sort(reverse=True)
            top_results = top_results[:200]

    top_results.sort(reverse=True)
    top_results = top_results[:top_k * 3]  # vezmeme více, pak filtrujeme

    # Načti metadata emailů
    final = []
    for score, email_id in top_results:
        row = cone_conn.execute(f"""
            SELECT id, subject, from_addr, to_addrs, sent_at, account_email,
                   SUBSTR(body, 1, 300) as snippet
            FROM emails e
            WHERE e.id = ?
            {date_filter.replace('e.sent_at', 'sent_at')}
            {evo_filter.replace('e.account_email', 'account_email')}
        """, (email_id,)).fetchone()

        if row:
            final.append({
                "score":   round(score, 4),
                "id":      row["id"],
                "subject": row["subject"] or "(bez předmětu)",
                "from":    row["from_addr"] or "",
                "date":    (row["sent_at"] or "")[:10],
                "account": row["account_email"] or "",
                "snippet": (row["snippet"] or "").replace("\n", " ")[:200],
            })
        if len(final) >= top_k:
            break

    emb_conn.close()
    cone_conn.close()

    elapsed = time.time() - t0
    print(f"Hotovo za {elapsed:.1f}s | zkontrolováno: {total_checked} embeddingů")
    return final


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("query", help="Hledaný dotaz")
    parser.add_argument("--top", type=int, default=10)
    parser.add_argument("--since", default=None, help="Od data YYYY-MM-DD")
    parser.add_argument("--include-evo", action="store_true",
                        help="Zahrnout Evolution emaily (POZOR: citlivá data)")
    args = parser.parse_args()

    results = search(
        args.query, top_k=args.top, since=args.since,
        skip_evolution=not args.include_evo
    )

    print(f"\n=== Top {len(results)} výsledků pro: '{args.query}' ===\n")
    for i, r in enumerate(results, 1):
        print(f"{i:2}. [{r['score']:.3f}] {r['date']}  {r['subject'][:60]}")
        print(f"     Od: {r['from'][:50]}")
        print(f"     {r['snippet'][:150]}")
        print()


if __name__ == "__main__":
    main()
