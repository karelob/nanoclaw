# Sprint — Koordinovaný improvement session

Tento skill spouští strukturovaný improvement sprint v CLI session.

## Kdy použít
Karel řekne "sprint", "/sprint", nebo "pojďme vylepšit systém".

## Postup

### 1. Ověř live stav (POVINNÉ — před čtením tracking souborů)

**Vždy spusť tyto příkazy a zobraz výsledky:**
```bash
# Ollama
curl -s --max-time 5 http://10.0.10.70:11434/api/tags | python3 -c "import sys,json; d=json.load(sys.stdin); print('Ollama UP:', [m['name'] for m in d['models']])" 2>/dev/null || echo "Ollama DOWN"

# cone-db MCP
ps aux | grep "cone-mcp/dist/index.js" | grep -v grep | awk '{print "cone-db MCP UP, PID=" $2}' || echo "cone-db MCP DOWN"

# NanoClaw
ps aux | grep "nanoclaw/dist/index.js" | grep -v grep | awk '{print "NanoClaw UP, PID=" $2}' || echo "NanoClaw DOWN"
```

Tracking soubory (system_health.md, agent log) mohou být zastaralé — live výsledky mají vždy přednost.

### 2. Načti stav
```bash
cat ~/Develop/nano-cone/knowledge/tracking/improvement_proposals.md
```

Zobraz Karlovi přehlednou tabulku:

```
# Improvement Sprint — [datum]

## Ready for Review (Burlak branches)
| # | Proposal | Branch | Size | Impact |
|---|----------|--------|------|--------|
| 1 | ...      | burlak/...| S  | high   |

## Approved (čeká na implementaci)
| # | Proposal | Size | Impact | Kdo |
|---|----------|------|--------|-----|
| 1 | ...      | M    | high   | CLI |

## Proposed (čeká na Karlovo rozhodnutí)
| # | Proposal | Size | Impact | ROI |
|---|----------|------|--------|-----|
| 1 | ...      | S    | high   | 1   |

Co chceš řešit? (číslo, "all", nebo "review" pro Burlak branches)
```

### 2. Karel vybere

**Pokud "review":**
- Pro každou branch NEJDŘÍV ověř relevanci: `git log main..burlak/... --oneline`
  - 0 commitů = branch je již v main → navrhnout smazat, NEprezentovat jako "k review"
  - >0 commitů = skutečně unmerged → zobrazit diff a zeptat se
- Pro skutečně unmerged branch: `git diff main...burlak/...`
- Ukaž diff, zeptej se: merge / zamítni / uprav
- Mergenuté: aktualizuj proposals.md → status: implemented, popiš co se stalo

**POZOR:** proposals.md je tracking soubor, může být zastaralý. Vždy důvěřuj `git log` více než statusu v proposals.

**Pokud číslo nebo "all":**
- Implementuj vybrané proposals
- Pro M/L size: nejdřív rozhodni přístup s Karlem, pak implementuj
- Commituj průběžně, ukazuj progress

**Pokud Karel chce nový nápad:**
- Zapiš jako nový proposal do improvement_proposals.md
- Implementuj ihned pokud Karel souhlasí

### 3. Sprint paralelizace (volitelné)

Pokud Karel řekne "pusť i Burlaka":
```bash
cd ~/Develop/nano-cone/burlak
nohup bash -c 'claude -p "Sprint mode. Přečti improvement_proposals.md, vyber approved + S-size proposals, implementuj do branches. Zapiš do Agent Log. Email přehled na karel@obluk.com." --allowedTools Read,Write,Edit,Bash,WebFetch,WebSearch' > /tmp/burlak-sprint.log 2>&1 &
echo "Burlak sprint PID: $!"
```

Sleduj paralelní progres: `tail -f /tmp/burlak-sprint.log` nebo Agent Log.

### 4. Sprint wrap-up

Na konci sprintu:
1. Aktualizuj `improvement_proposals.md` — statusy všech řešených proposals
2. Aktualizuj `active_session.md` — co bylo hotové
3. Agent Log: `[YYYY-MM-DD HH:MM CLI]: Sprint — implemented P-001, P-003, reviewed burlak/..., merged 2 branches`
4. Pokud zbývají nevyřešené proposals: označ jako "sprint-deferred" s důvodem

### 5. Post-sprint signal collection

Po sprintu spusť rychlou reflexi:
- Co fungovalo dobře?
- Co bylo zbytečně složité?
- Objevily se nové problémy?
Zapiš jako signály do improvement_signals.md s tagem `[sprint-retrospective]`.
