---
name: contact
description: Vyhledá kontakt v cone.db (entity, emaily, kalendář, závazky, dokumenty) a vytvoří strukturovaný profil. Automaticky ukládá do knowledge/people/.
---
Zjisti vše o kontaktu *$ARGUMENTS* a vytvoř strukturovaný profil.

*Detekce prostředí:*
```bash
# Nastav cesty podle prostředí (kontejner vs host)
if [ -f /workspace/local-db/cone.db ]; then
  DB=/workspace/local-db/cone.db
  KNOWLEDGE=$KNOWLEDGE
elif [ -f "$HOME/Develop/nano-cone/cone/db/cone.db" ]; then
  DB="$HOME/Develop/nano-cone/cone/db/cone.db"
  KNOWLEDGE="$HOME/Develop/nano-cone/knowledge"
fi
```

Zdroje dat (projdi VŠECHNY):

*1. DB entity a fakta*
```bash
sqlite3 $DB "
SELECT e.id, e.name, e.type, e.description FROM entities e
LEFT JOIN entity_aliases a ON e.id = a.entity_id
WHERE e.name LIKE '%$ARGUMENTS%' OR a.alias LIKE '%$ARGUMENTS%'
LIMIT 10;"

# Pak pro nalezené entity_id:
sqlite3 $DB "SELECT category, key, value FROM facts WHERE entity_id = [ID];"
sqlite3 $DB "
SELECT e2.name, r.relation_type, r.description FROM relations r
JOIN entities e2 ON e2.id = CASE WHEN r.from_entity_id = [ID] THEN r.to_entity_id ELSE r.from_entity_id END
WHERE r.from_entity_id = [ID] OR r.to_entity_id = [ID];"
```

*2. Emaily*
```bash
sqlite3 $DB "
SELECT subject, from_addr, sent_at FROM emails
WHERE from_addr LIKE '%$ARGUMENTS%' OR to_addrs LIKE '%$ARGUMENTS%' OR subject LIKE '%$ARGUMENTS%'
ORDER BY sent_at DESC LIMIT 10;"
```

*3. Kalendář*
```bash
sqlite3 $DB "
SELECT summary, start_dt, location, attendees FROM events
WHERE (attendees LIKE '%$ARGUMENTS%' OR summary LIKE '%$ARGUMENTS%')
AND calendar_id IN ('karel@obluk.com','karel.obluk@evolutionequity.com')
ORDER BY start_dt DESC LIMIT 10;"
```

*4. Závazky*
```bash
sqlite3 $DB "
SELECT description, counterparty, due_date, status, direction FROM commitments
WHERE counterparty LIKE '%$ARGUMENTS%' AND status = 'open';"
```

*5. Dokumenty*
```bash
sqlite3 $DB "
SELECT title, summary, file_path FROM documents
WHERE summary LIKE '%$ARGUMENTS%' OR title LIKE '%$ARGUMENTS%'
ORDER BY pub_date DESC LIMIT 10;"
```

Výstupní formát (Telegram):

*[Jméno] — profil kontaktu*

_Základní info_
• Firma / pozice:
• Email:
• Telefon:
• Typ vztahu: (business partner / investor / právník / osobní / ...)

_Poslední komunikace_
• Datum:
• Téma:

_Historie (posledních 5 interakcí)_
• ...

_Otevřené body_
• Závazky Karla vůči této osobě:
• Požadavky od této osoby:

_Společné schůzky (nadcházející)_
• ...

_Kontext a poznámky_
• Relevantní fakta z DB
• Vztahy k dalším entitám

Pokud o kontaktu nejsou žádná data, řekni to rovnou — nevymýšlej.

---

*WRITE-BACK: Po sestavení profilu VŽDY ulož/aktualizuj do knowledge repo:*

1. Zkontroluj, jestli existuje `$KNOWLEDGE/people/{jmeno_prijmeni}.md`
2. Pokud NE → vytvoř nový soubor s YAML frontmatter:
```markdown
---
entity_id: [ID z cone.db nebo null]
type: person
name: [Plné jméno]
cone_email: [primární email]
last_updated: [dnešní datum YYYY-MM-DD]
tags: [relevantní tagy]
---
# [Jméno]
## Kontext vztahu
[shrnutí z výše sestaveného profilu — firma, role, typ vztahu]
## Poslední komunikace
[datum + téma]
## Otevřené body
[závazky, úkoly]
## Poznámky
[relevantní fakta, vztahy k dalším lidem]
```
3. Pokud ANO → aktualizuj existující soubor (přepiš sekce novými daty, zachovej manuálně přidané poznámky)
4. Aktualizuj `last_updated` v YAML frontmatter
5. Aktualizuj `$KNOWLEDGE/people/_index.md` — přidej osobu pokud tam není

Jméno souboru: lowercase, podtržítka místo mezer (např. `jan_novak.md`).
