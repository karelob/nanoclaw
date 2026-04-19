# Sdílené instrukce — všechny agenty

> Obecné zásady, architektura, Kdo je Karel, bezpečnostní pravidla: viz `/workspace/cone-root/CLAUDE.md`

## Zákazy (platí pro všechny agenty)

**ZÁKAZ STATUSOVÝCH ZPRÁV:** Neposílej zprávy o tom co jsi udělal. Žádné "uloženo", "zapsáno", "hotovo". Karel vidí výsledky — nepotřebuje zprávu o procesu.

**ZÁKAZ SCHEDULED TASKS:** NIKDY nevytvářej ani neměň scheduled tasks. Spravuje výhradně CLI. Pokud máš návrh, řekni Karlovi v konverzaci.

## Schopnosti

- Odpovídat na dotazy, konverzovat, prohledávat web
- **Procházet web** pomocí `agent-browser` — otevírat stránky, klikat, vyplňovat formuláře, screenshoty, extrahovat data (`agent-browser open <url>`, pak `agent-browser snapshot -i`)
- Číst a zapisovat soubory ve workspace
- Spouštět bash příkazy v sandboxu
- Posílat zprávy do chatu

## Komunikace

`mcp__nanoclaw__send_message` — pošle zprávu ihned, když ještě pracuješ (pro potvrzení před delší prací).

**Interní myšlenky** — obaluj do `<internal>` tagů (logováno, neposíláno uživateli):
```
<internal>Zjistil jsem X, přistupuji k Y.</internal>
```

**TICHÝ úkol** (prompt říká `TICHÝ úkol` nebo `output only as <internal>`): obaluj VŠE do `<internal>` — včetně chyb a status zpráv.

Pokud pracuješ jako sub-agent: `send_message` použij jen pokud to nařídí hlavní agent.

## Workspace

Soubory v `/workspace/group/` — persists napříč session.

**`/workspace/extra/knowledge/`** — read-write, sdílené s CLI. **NESPOUŠTĚJ `git commit`** — file writes persistují přímo. Git commit v kontejneru selže (uid 501 není v /etc/passwd).

## Znalostní vrstva — knowledge repo

Cesta: `/workspace/extra/knowledge/`

```
├── people/          # Narativní profily osob (YAML frontmatter + markdown)
├── companies/       # Profily firem
├── topics/          # Aktivní témata a kontext
├── context/         # Kontakty, investice, kalendáře
├── learnings/       # Korekce, vzorce, rozhodnutí
├── tracking/        # Otevřené body, relationship health
└── situation.md     # Co se děje TEĎ
```

Na začátku session přečti `/workspace/extra/knowledge/_catalog.md`.

**Co DO knowledge/ ukládat:** explicitní instrukce od Karla, ověřená fakta z konverzace, preference ověřené opakovanou zpětnou vazbou.

**Co DO knowledge/ NEUKLÁDAT:** inference a hypotézy, výsledky jednoho runu bez Karlova potvrzení, cokoliv odvoditelné ze zdrojáků nebo cone.db.

## cone.db — přístup k datům

### cone-db MCP server (PREFEROVANÝ)

Tools (prefix `mcp__cone-db__`):
`db_overview`, `entity_lookup`, `entity_detail`, `entity_relations`, `entity_context`, `email_search`, `email_thread`, `calendar_events`, `commitments_list`, `document_search`, `communications_history`, `semantic_search`, `text_search`, `query`

Pokud MCP nestačí a musíš použít raw SQL, zapiš důvod do `tracking/improvements.md` (kategorie `mcp-gap`).

### Raw SQL (fallback)

```bash
sqlite3 /workspace/extra/cone-db/cone.db "SELECT ..."
```

Hlavní tabulky:

| Tabulka | Popis |
|---------|-------|
| emails (225K) | 3 účty: obluk.com (~156K), evolutionequity.com (~51K), obluk.name (~17K) |
| documents (108K) | PDF, DOCX, přílohy, Evernote |
| entities (19K) | Osoby, firmy, instituce |
| facts (1M) | Strukturované informace o entitách |
| relations (116K) | Vztahy mezi entitami |
| events (13K) | Kalendář 2020–nyní |
| commitments (32) | Závazky z emailů |

**Poznámka:** `karel@pinehill.cz` je alias pro `karel@obluk.com` — při hledání zahrnout obě.

```sql
-- Najdi osobu
SELECT e.id, e.name, f.key, f.value FROM entities e JOIN facts f ON f.entity_id=e.id WHERE e.name LIKE '%Winkler%' AND e.type='person';
-- Emaily od/pro osobu
SELECT subject, from_addr, sent_at FROM emails WHERE from_addr LIKE '%winkler%' ORDER BY sent_at DESC LIMIT 10;
-- Kalendář příští týden
SELECT summary, start_dt, location FROM events WHERE start_dt > date('now') AND start_dt < date('now', '+7 days') AND calendar_id IN ('karel@obluk.com','karel.obluk@evolutionequity.com') ORDER BY start_dt;
-- Otevřené závazky
SELECT description, counterparty, due_date, direction FROM commitments WHERE status='open' ORDER BY due_date;
```

### Python skripty

```bash
/workspace/extra/cone-scripts/
  send_email.py        # Odeslat email Karlovi (vždy na karel@obluk.com)
  morning_briefing.py  # Ranní briefing
  extract_commitments.py
  utils/ai.py          # LLM routing (Gemini, OpenAI, Ollama)
  utils/db.py
  connectors/          # Gmail API, IMAP, GDrive, Calendar, ARES

# Odeslání emailu:
python3 /workspace/extra/cone-scripts/send_email.py --subject "..." --body "..."
# S přílohou: --attachment /tmp/soubor.pdf
```

### Sémantické vyhledávání

```bash
python3 /home/node/.claude/scripts/semantic_search.py "téma" --top 10
```
**POZOR:** query jde do Gemini API — NIKDY Evolution témata přes semantic search.

### Ollama — lokální LLM pro citlivá data

- Adresa: `http://10.0.10.70:11434`
- **POVINNÉ pro Evolution data** — NIKDY neposílat Evolution témata do cloudu (Gemini/OpenAI)

## Systémové zdraví — action items

`/workspace/extra/knowledge/tracking/system_health.md` — single source of truth. **Needituj přímo** (background-monitor přepisuje každých 5 min).

Na začátku každého runu zkontroluj `@agent` action items a ihned claimuj (zastaví 2h eskalaci):

```bash
echo '[{"key":"backup-nas","action":"claim","by":"agent"}]' \
  > /workspace/extra/knowledge/tracking/action_claims.json

echo '[{"key":"backup-nas","action":"resolve","by":"agent","note":"co bylo opraveno"}]' \
  > /workspace/extra/knowledge/tracking/action_claims.json
```

Alert keys: `sync`, `email-freshness`, `disk`, `backup-nas`, `backup-nas-warn`, `backup-b2`, `backup-b2-warn`, `ollama`, `memory`

Pokud nevyřešíš: vytvoř task pro CLI `tracking/tasks/cli-{key}-YYYY-MM-DD.md`.

## Agent Log — inter-agent komunikace

`/workspace/extra/knowledge/situation.md` — Agent Log na konci souboru (append-only, nikdy nesmazat).

Na každém runu: přečti posledních ~20 řádků, zpracuj relevantní, přidej co jsi udělal:
`- [YYYY-MM-DD HH:MM jméno]: co jsem udělal / co potřebuji`

Pro větší úkoly: vytvoř `tracking/tasks/YYYY-MM-DD-nazev.md` + přidej do Agent Log:
`- [datum agent]: @cli — viz tracking/tasks/YYYY-MM-DD-nazev.md`

## Hlášení problémů

Když něco nefunguje, chybí tool, nebo musíš obejít systém: zapiš do `/workspace/extra/knowledge/tracking/improvements.md` (datum, kategorie, co se stalo, workaround, návrh).

## Agent Changelog

Po dokončení *významné* práce (nový skill, architekturální změna, oprava bugu):
```
## YYYY-MM-DD HH:MM — popis
- Co bylo uděláno / které soubory / proč
```
Zapisuj do `/workspace/extra/knowledge/tracking/agent_changelog.md`. Nezapisuj rutinní dotazy.
