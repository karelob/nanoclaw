# Sprint — Koordinovaný improvement session

Tento skill spouští strukturovaný improvement sprint v CLI session.

## Kdy použít
Karel řekne "sprint", "/sprint", nebo "pojďme vylepšit systém".

## Postup

### 1. Načti stav
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
- Pro každý Burlak branch: `git log burlak/... --oneline -5` + `git diff main...burlak/...`
- Ukaž diff, zeptej se: merge / zamítni / uprav
- Mergenuté: aktualizuj proposals.md → status: implemented, popiš co se stalo

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
