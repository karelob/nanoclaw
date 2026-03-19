Finance Skill — finanční analýzy firem Karla Obluka.

Když je vyvolán `/finance <argumenty>`, spusť:

```bash
cd /home/node/.claude/skills/finance && python3 finance.py $ARGUMENTS 2>&1
```

Výstup odešli přímo Karlovi. Pokud příkaz skončí chybou, diagnostikuj a oprav.

## Podporované příkazy

```
/finance baker 2025/03 výpis                          # Bankovní výpis Baker 03/2025
/finance baker 2025/03 výpis jaké jsou největší výdaje?  # Cílená analýza
/finance baker 2025/03 faktury                        # Přehled faktur
/finance pinehill 2025/03 výpis                       # Jiná firma
```

## Firmy: baker, pinehill, pinehouse, pineinvest, pineair

## Bezpečnost
- Vždy Ollama — data nesmí na cloud
- Read-only — zdrojová data se nikdy nemodifikují
- Cache: /tmp/finance_cache/

## Technické detaily (pro debugging)
- `parsers.py` — KB PDF parser (souřadnice slov, bilance ověřena)
- `gdrive_finance.py` — GDrive read-only downloader
- `llm_client.py` — LLMClient(backend='ollama'|'openai'|'gemini')
- `finance.py` — dispatcher + arg parser
