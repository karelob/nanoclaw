---
name: finance
description: Finanční analýzy firem Karla Obluka — bankovní výpisy, faktury, cashflow, PMD, rozvaha, VZZ, DPPO. Data z GDrive (Business Docs 2013-2024, Účetnictví Obluk 2025+). Vždy Ollama pro citlivá data.
---
Finance Skill — finanční analýzy firem Karla Obluka.

Když je vyvolán `/finance <argumenty>`, spusť:

```bash
# Najdi skills dir (kontejner nebo host)
if [ -d /home/node/.claude/skills/finance ]; then
  cd /home/node/.claude/skills/finance
else
  cd "$(dirname "$(readlink -f "$0" 2>/dev/null || echo .)")/../container/skills/finance" 2>/dev/null || cd container/skills/finance
fi
python3 finance.py $ARGUMENTS 2>&1
```

Výstup odešli přímo Karlovi. Pokud příkaz skončí chybou, diagnostikuj a oprav.

## Podporované příkazy

### Bankovní výpisy (KB)
```
/finance baker 2025/03 výpis                          # Bankovní výpis Baker 03/2025
/finance baker 2023/12 výpis                          # Historická data z Business Docs
/finance baker 2025/03 výpis jaké jsou největší výdaje?  # Cílená analýza
/finance pinehill 2025/03 výpis                       # Jiná firma
```

### Faktury
```
/finance baker 2025/03 faktury                        # Přehled faktur
```

### České účetnictví (roční výkazy)
```
/finance baker 2023 pmd                               # Pohyby na daňovém účtu (CSV export z FS)
/finance baker 2023 pmd kolik bylo na DPH?             # PMD s cílenou otázkou
/finance baker 2023 rozvaha                           # Rozvaha (balance sheet)
/finance baker 2023 vzz                               # Výkaz zisku a ztráty (P&L)
/finance baker 2023 výkazy                            # Rozvaha + VZZ dohromady
/finance baker 2023 analýza                           # Kompletní analýza (PMD + výkazy + LLM)
/finance baker 2023 analýza jak je na tom firma?       # Analýza s otázkou
```

### Cashflow projekce
```
/finance baker cashflow                               # Projekce 3 měsíce dopředu (6 měs. dat)
/finance pinehill cashflow                            # Pinehill cashflow
/finance all cashflow                                 # Konsolidovaný pohled skupiny (všechny firmy)
/finance baker cashflow kde jsou největší rizika?     # Projekce s cílenou otázkou
```

Cashflow analýza:
- Načte posledních 6 měsíců bankovních výpisů
- Rozlišuje: smluvní závazky (z `/contracts` indexu), vzorce z opakování, jednorázové platby
- Intra-group toky (Baker↔Pinehill↔PineAir↔Karel Obluk) vyznačeny zvlášť, neprojektovány
- Výstup: tabulka projekce měsíc po měsíci + Ollama analýza rizik

### Ostatní
```
/finance baker roky                                   # Zobrazí dostupné roky
```

## Firmy: baker, pinehill, pinehouse, pineinvest, pineair

## Datové zdroje (automaticky dle roku)
- 2025+ → Účetnictví Obluk (strukturované měsíční složky)
- 2013–2024 → Business Docs (historické účetnictví)

### Účetní výkazy (DPPO složka)
- `Rozvaha v plném rozsahu {rok}.pdf` — aktiva/pasiva
- `Výkaz zisku a ztráty v plném rozsahu {rok}.pdf` — výnosy/náklady
- `DPPO {rok}.pdf` / `{Firma} DPPO {rok}.pdf` — daňové přiznání
- PMD CSV — pohyby na daňovém účtu (celý rok)

## Bezpečnost
- Vždy Ollama — data nesmí na cloud
- Read-only — zdrojová data se nikdy nemodifikují
- Cache: /tmp/finance_cache/

## Technické detaily (pro debugging)
- `paths.py` (v parent dir) — sdílená detekce prostředí (kontejner vs host)
- `parsers.py` — KB PDF parser (souřadnice slov, bilance ověřena)
- `accounting.py` — PMD CSV parser, Rozvaha/VZZ/DPPO PDF parsery
- `gdrive_finance.py` — GDrive read-only downloader (oba drives)
- `llm_client.py` — LLMClient(backend='ollama'|'openai'|'gemini')
- `finance.py` — dispatcher + arg parser
