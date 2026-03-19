---
name: finance
description: Finanční analýzy firem Karla Obluka — bankovní výpisy, faktury, cashflow. Data z GDrive (Business Docs 2013-2024, Účetnictví Obluk 2025+). Vždy Ollama pro citlivá data.
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

```
/finance baker 2025/03 výpis                          # Bankovní výpis Baker 03/2025
/finance baker 2023/12 výpis                          # Historická data z Business Docs
/finance baker 2025/03 výpis jaké jsou největší výdaje?  # Cílená analýza
/finance baker 2025/03 faktury                        # Přehled faktur
/finance pinehill 2025/03 výpis                       # Jiná firma
/finance baker roky                                   # Zobrazí dostupné roky
```

## Firmy: baker, pinehill, pinehouse, pineinvest, pineair

## Datové zdroje (automaticky dle roku)
- 2025+ → Účetnictví Obluk (strukturované měsíční složky)
- 2013–2024 → Business Docs (historické účetnictví)

## Bezpečnost
- Vždy Ollama — data nesmí na cloud
- Read-only — zdrojová data se nikdy nemodifikují
- Cache: /tmp/finance_cache/

## Technické detaily (pro debugging)
- `paths.py` (v parent dir) — sdílená detekce prostředí (kontejner vs host)
- `parsers.py` — KB PDF parser (souřadnice slov, bilance ověřena)
- `gdrive_finance.py` — GDrive read-only downloader (oba drives)
- `llm_client.py` — LLMClient(backend='ollama'|'openai'|'gemini')
- `finance.py` — dispatcher + arg parser
