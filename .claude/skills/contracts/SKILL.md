---
name: contracts
description: Smluvní závazky firem Karla Obluka — pronájmy, úvěry, HR, vozidla, služby. Extrahuje strukturovaná data ze smluv v GDrive Business Docs. Podklad pro cashflow projekce a křížovou kontrolu. Gemini/Ollama backend.
---
Contracts Skill — smluvní dokumentace a závazky firem Karla Obluka.

Když je vyvolán `/contracts <argumenty>`, spusť:

```bash
if [ -d /home/node/.claude/skills/contracts ]; then
  cd /home/node/.claude/skills/contracts
else
  cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo .)")/../container/skills/contracts" 2>/dev/null || cd container/skills/contracts
fi
python3 contracts.py $ARGUMENTS 2>&1
```

Výstup odešli přímo Karlovi. Pokud příkaz skončí chybou, diagnostikuj a oprav.

## Podporované příkazy

### Přehled smluv
```
/contracts pinehill list              # Všechny indexované smlouvy Pinehill
/contracts baker list                 # Smlouvy Baker
/contracts all list                   # Cross-company přehled
```

### Platební závazky (pro cashflow)
```
/contracts pinehill platby            # Smluvní platební závazky Pinehill
/contracts all platby                 # Celkový cross-company platební přehled
```

### HR smlouvy
```
/contracts pinehill hr                # Zaměstnanecké smlouvy + dohody Pinehill
/contracts baker hr                   # HR Baker
/contracts all hr                     # HR všechny firmy
```
HR přehled zahrnuje typ (HPP/DPP/DPČ), hrubou mzdu a odhad celkového nákladu (HPP: hrubá + ~33,8 % odvody zaměstnavatele).

### Expirace
```
/contracts expiring                   # Expirující do 90 dní (všechny firmy)
/contracts expiring 30                # Expirující do 30 dní
```

### Indexace
```
/contracts pinehill scan              # Náhled: kolik souborů bez indexace
/contracts pinehill index             # Indexuj / aktualizuj index (přírůstkově)
/contracts all index                  # Indexuj všechny firmy
/contracts pinehill index --force     # Přeindexuj vše od začátku
```

## Firmy: baker, pinehill, pinehouse, pineinvest, pineair, all

## Datový zdroj
- GDrive Business Docs / {Firma} / * — celá struktura firmy
- Prochází: Smlouvy ostatní, Smlouvy personální, Konzultace, Auta, Finance/Obluk Karel*, Společnost
- Přeskakuje: Datová schránka, Handling, Aircraft, Marketing, Korespondence

## Typy smluv
- **rental** — pronájem (kancelář Opero/Regus, nemovitosti)
- **loan** — zápůjčka/úvěr (Karel↔firmy, bankovní úvěry)
- **service** — služby (O2, Vodafone, bezpečnost, IT, účetní)
- **hr** — zaměstnanecké smlouvy + DPP/DPČ dohody
- **vehicle** — auta, leasing, financing
- **consulting** — poradenství, advisory (Evolution Equity, GLG, KKR…)
- **corporate** — zakladatelské, VH usnesení, plné moci

## Bezpečnost a modely
- Extrakce: Gemini (výchozí) — lepší porozumění složitých dokumentů
- Fallback: Ollama (pokud Gemini nedostupný nebo dle nastavení)
- Read-only — zdrojová data se nikdy nemodifikují
- Index cache: ~/.cache/nanoclaw/contracts/{firma}_contracts.json

## Technické detaily
- `gdrive_contracts.py` — navigace GDrive, kategorizace dle cesty
- `contract_parser.py` — LLM extrakce, hashový přírůstkový index
- `contracts.py` — dispatcher + arg parser
- `llm_client.py` — sdílený z finance skill (SKILLS_DIR/finance/)
