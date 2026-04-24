---
name: company
description: Vyhledá firmu v cone.db a Affinity CRM a vytvoří strukturovaný profil. Automaticky ukládá do knowledge/companies/.
---
Zjisti vše o firmě *$ARGUMENTS* a vytvoř strukturovaný profil.

Tento skill je CLI-only — používá cone-db MCP a Affinity MCP místo přímých sqlite3 dotazů.

---

## Krok 1 — Najít entitu v cone.db

Zavolej `mcp__cone-db__entity_lookup` s `query="$ARGUMENTS"` a `type="company"`.

Pokud více výsledků → vyber nejrelevantnější (nejčastěji zmiňovaná nebo s nejvíce fakty). Pokud nejednoznačné, vypiš možnosti a zeptej se.

**KRITICKÉ pravidlo — žádná fabrikace:**
Pokud `entity_lookup` vrátí `count: 0` nebo error:
1. Napiš Karlovi přesně: *"cone-db nevrátil žádnou firmu pro dotaz `$ARGUMENTS`. Zkus jinou variantu, přidej/odeber právní formu (s.r.o., a.s., …), nebo zkontroluj diakritiku."*
2. **ZASTAV SE — nevytvářej profil.** Nikdy nesestavuj profil jen z názvu firmy, ARES dotazů naslepo, nebo obecných znalostí. Nikdy nevymýšlej ICO, sídlo, pozice ani vztahy.
3. Před každým faktem v profilu: *"Viděl jsem tento údaj v MCP odpovědi?"* Pokud ne, fakt **tam nesmí být**.

Zapiš `entity_id` — použiješ ho ve všech dalších krocích.

---

## Krok 2 — Kompletní profil entity

Zavolej `entity_detail(entity_id=ID)`.

Z výsledku extrahuj:
- **Fakta** podle kategorií:
  - `pracovni`: ICO, DIC, pravni_forma, datum_vzniku, nace, stav (AKTIVNI/LIKVIDACE)
  - `kontakt`: sidlo, email, telefon, poznamka
  - `finance`: zapujcka_karel_*, investice_*, částky, role
  - `firma`: popis, typ
  - `company`: zamestnancu_aktivni, zaměstnanci
  - `investice`, `business`, `classification`: odvětví, role, kolo
- **Relace** (ignoruj typy `dokument_*` — těch je příliš):
  - `employee`, `founder`, `works_at` → klíčové osoby
  - `partner`, `client`, `investor`, `board`, `portfolio_company` → obchodní vztahy
- **Dokumenty**: max 5 nejnovějších

---

## Krok 3 — Cross-source kontext

Zavolej `entity_context(entity_id=ID, days_back=365)`.

Extrahuj: komunikační statistiky, poslední emaily (subjekty), otevřené závazky obě strany, nadcházející events.

---

## Krok 4 — Historie komunikace

Zavolej `communications_history(entity_id=ID, period="month")`.

Extrahuj: celkový počet sent/received, datum posledního kontaktu, poslední subjekty.

Pokud entity_context already obsahuje dostatečné komunikační info, přeskoč.

---

## Krok 5 — Emaily (doplněk)

Pokud znáš doménu firmy (z aliasů nebo faktů), zavolej:
`email_search(from=DOMAIN, date_from="1 year ago", limit=5)`.

Nebo: `email_search(subject="$ARGUMENTS", date_from="6 months ago", limit=5)`.

---

## Krok 6 — Závazky

Zavolej `commitments_list(counterparty="$ARGUMENTS", status="open")`.

---

## Krok 7 — Dokumenty

Zavolej `document_search(entity_id=ID, limit=10)`.

---

## Krok 8 — Kalendář

Zavolej `calendar_events(search="$ARGUMENTS", date_from="today", limit=5)`.

---

## Krok 9 — Affinity CRM (sekundární)

Zavolej `search_companies(name="$ARGUMENTS")`.

Pokud nalezena:
- `get_company_info(company_id)` → domain, description, stage
- `get_notes_for_entity(entity_id)` → poslední poznámky
- `get_meetings_for_entity(entity_id)` → schůzky

Pokud Affinity nic nenajde — přeskoč tuto sekci bez chyby.

---

## Výstup pro uživatele (Telegram formát)

```
*[Název firmy] — profil firmy*

_Základní info_
• IČO / DIČ:
• Právní forma / stav:
• Sídlo:
• Datum vzniku:
• Odvětví (NACE):
• Popis:

_Vztah s Karlem_
• Typ: (investor / věřitel / zákazník / partner / ...)
• Finanční angažmá (pokud relevantní):
• Role Karla:

_Klíčové osoby_
• Jméno — role

_Komunikace_
• Celkem emailů: X (sent: Y, received: Z)
• Poslední kontakt:
• Poslední téma:

_Otevřené body_
• Závazky Karla vůči firmě:
• Požadavky firmy na Karla:
• Nadcházející events:

_Dokumenty_
• (max 5 nejnovějších relevantních)

_Affinity_
• Stage, poslední poznámka, schůzky (nebo: "nenalezeno v Affinity")

_Poznámky_
• Relevantní fakta, vztahy k dalším entitám
```

Pokud o firmě nejsou žádná data → řekni to rovnou, nevymýšlej.

---

## WRITE-BACK: Uložit profil do knowledge repo

Po sestavení profilu VŽDY ulož/aktualizuj:

**1. Zjisti cestu ke knowledge repo:**
```bash
if [ -d "$HOME/Develop/nano-cone/knowledge" ]; then
  KNOWLEDGE="$HOME/Develop/nano-cone/knowledge"
fi
```

**2. Jméno souboru:** lowercase, podtržítka místo mezer a speciálních znaků, přípona `.md`.
Příklady: `evolution_equity_partners.md`, `baker_estates.md`, `komercni_banka.md`

**3. Zkontroluj, jestli existuje `$KNOWLEDGE/companies/{slug}.md`**

**4a. Pokud NE → vytvoř nový soubor:**
```markdown
---
entity_id: [ID z cone.db nebo null]
type: company
name: [Plný název]
ico: [IČO nebo null]
domain: [doména nebo null]
last_updated: [dnešní datum YYYY-MM-DD]
tags: [relevantní tagy — odvětví, typ-vztahu, stav]
---
# [Název]

## Identita
[právní forma, stav, NACE kódy, popis]

## Kontakt
[sídlo, email, telefon, web/doména]

## Vztah s Karlem
[typ vztahu, finanční angažmá, role]

## Klíčové osoby
[zakladatelé, executives, zaměstnanci s rolemi]

## Události
> Nejnovější první. Typy: `Email` | `Schůzka` | `Závazek` | `Investice` | `Výzkum` | `Dokument` | `Naplánováno`

### YYYY-MM-DD | [typ] — [stručný popis]
[detail události]
```

**4b. Pokud ANO → aktualizuj existující soubor:**
- Přepiš sekce Identita, Kontakt, Vztah s Karlem, Klíčové osoby novými daty
- Přidej nové události do Události (zachovej historii, jen prepend nové)
- Zachovej manuálně přidané poznámky
- Aktualizuj `last_updated` v YAML frontmatter

**5. Aktualizuj `$KNOWLEDGE/companies/_index.md`** — přidej firmu pokud tam není:
```markdown
| [Název] | [entity_id] | [typ vztahu] | [last_updated] |
```
