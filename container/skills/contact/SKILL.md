---
name: contact
description: Vyhledá kontakt v cone.db (entity, emaily, kalendář, závazky, dokumenty) a vytvoří strukturovaný profil. Automaticky ukládá do knowledge/people/.
---
Zjisti vše o kontaktu *$ARGUMENTS* a vytvoř strukturovaný profil.

Tento skill je CLI-only — používá cone-db MCP místo přímých sqlite3 dotazů.

---

## Krok 1 — Najít entitu

Zavolej `entity_lookup` s `query="$ARGUMENTS"` a `type="person"`.

Pokud více výsledků → vyber nejrelevantnější. Pokud nejednoznačné → vypiš možnosti a zeptej se.

Zapiš `entity_id` — použiješ ho ve všech dalších krocích.

---

## Krok 2 — Kompletní profil entity

Zavolej `entity_detail(entity_id=ID)`.

Extrahuj: základní info, fakta (email, telefon, role, firma, sídlo), relace (employer, works_at, partner, investor), dokumenty.

---

## Krok 3 — Cross-source kontext

Zavolej `entity_context(entity_id=ID, days_back=365)`.

Extrahuj: komunikační statistiky, poslední emaily (subjekty), otevřené závazky obě strany, nadcházející events, 1-hop relace.

---

## Krok 4 — Emaily

Zavolej `email_search(from="$ARGUMENTS", date_from="1 year ago", limit=10)`.

Nebo pokud znáš email z faktů: `email_search(from=EMAIL, date_from="1 year ago", limit=10)`.

---

## Krok 5 — Závazky

Zavolej `commitments_list(counterparty="$ARGUMENTS", status="open")`.

---

## Krok 6 — Kalendář

Zavolej `calendar_events(search="$ARGUMENTS", date_from="today", limit=5)`.

---

## Krok 7 — Dokumenty

Zavolej `document_search(entity_id=ID, limit=5)`.

---

## Výstup pro uživatele (Telegram formát)

```
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
```

Pokud o kontaktu nejsou žádná data → řekni to rovnou, nevymýšlej.

---

## WRITE-BACK: Uložit profil do knowledge repo

Po sestavení profilu VŽDY ulož/aktualizuj:

**1. Zjisti cestu:**
```bash
if [ -d "$HOME/Develop/nano-cone/knowledge" ]; then
  KNOWLEDGE="$HOME/Develop/nano-cone/knowledge"
fi
```

**2. Zkontroluj, jestli existuje `$KNOWLEDGE/people/{jmeno_prijmeni}.md`**

**3a. Pokud NE → vytvoř nový soubor:**
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

## Identita
[role, firma, oblast]

## Kontakt
[email, telefon, LinkedIn]

## Vztahy
[klíčové vztahy a kontext]

## Události
> Nejnovější první. Typy: `Setkání` | `Email` | `Telefon` | `Propojení` | `Závazek` | `Výzkum` | `Naplánováno`

### YYYY-MM-DD | [typ] — [stručný popis]
[detail]
```

**3b. Pokud ANO → aktualizuj existující soubor:**
- Přepiš statické sekce (Identita, Kontakt, Vztahy) novými daty
- Přidej nové události do Události (zachovej historii)
- Zachovej manuálně přidané poznámky
- Aktualizuj `last_updated` v YAML frontmatter

**4. Aktualizuj `$KNOWLEDGE/people/_index.md`** — přidej osobu pokud tam není.

Jméno souboru: lowercase, podtržítka místo mezer (např. `jan_novak.md`).
