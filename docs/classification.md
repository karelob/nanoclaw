# Email classification pipeline

Burlak klasifikuje příchozí emaily pomocí LLM a ukládá výsledky do `cone_inbox` tabulky v `cone.db`. Pipeline detekuje akce (todo), zprávy k souhrnu, studie a FYI emaily — včetně implicitních akcí kde odesílatel nevypsal přímou výzvu.

---

## Labely

| Label | Kdy | reply_needed |
|-------|-----|-------------|
| `ignore` | Spam, marketing, automatické notifikace | vždy false |
| `summary` | Newslettery, pravidelné market updates | vždy false |
| `todo` | Konkrétní akce pro Karla — včetně implicitních | vždy true |
| `study` | Fund reporty, DD materiály, finanční výsledky | true jen pokud autor čeká feedback |
| `fyi` | Osobní zprávy, koordinace, obecné updaty | true jen při přímé/nepřímé žádosti o reakci |

### Implicitní akce (todo) — příklady

LLM detekuje akci i bez explicitního "prosím odpověz":

- Calendly / scheduling odkaz → Karel musí vybrat termín
- Žádost o intro / představení → Karel musí napsat zprávu
- "bylo by fajn kdyby", "ocenil bych" + konkrétní odkaz nebo dokument
- Formulář k vyplnění, dokument k podpisu, anketa
- Žádost o zpětnou vazbu, review nebo rozhodnutí

---

## Modely

| Account | Primární model | Fallback | Důvod |
|---------|---------------|---------|-------|
| `evolutionequity.com` | Ollama `qwen3.5:9b` | žádný | Evolution data nikdy do cloudu |
| `obluk.com`, `obluk.name` | Ollama `qwen3.5:9b` | Gemini 2.5 Flash (confidence < 0.7) | Lepší reply_needed detekce |

Model je uložen v `cone_inbox.model` pro audit.

---

## DB schéma — cone_inbox

Klíčové sloupce relevantní pro klasifikaci a feedback:

| Sloupec | Typ | Popis |
|---------|-----|-------|
| `label` | TEXT | Aktuální label (mění se při korekci) |
| `auto_label` | TEXT | Co systém predikoval — nemění se nikdy |
| `reply_needed` | INTEGER | 0/1 — systém vyhodnotil, že Karel musí odpovědět |
| `confidence` | REAL | 0.0–1.0 — jistota predikce |
| `model` | TEXT | Model který klasifikoval |
| `correction` | INTEGER | 1 = Karel opravil systémovou predikci |
| `corrected_at` | TIMESTAMP | Kdy byla korekce provedena |
| `correction_note` | TEXT | Volitelný důvod korekce |
| `status` | TEXT | `auto` / `corrected` / `confirmed` / `processed` |

---

## Feedback workflow — doporučený postup

Klasifikátor se učí z Karlových korekcí. Korekce jsou automaticky zahrnuty do few-shot příkladů při dalším runu (váha 3× oproti normálním labelům).

### Možnost A — přes Gmail (automatická detekce)

1. V Gmailu přetáhni email do jiné `Cone/` složky (např. z `Cone/ignore` do `Cone/todo`)
2. Burlak COLLECT run (nebo `auto_label_emails.py`) detekuje mismatch → nastaví `correction=1`, `corrected_at=now()`
3. Při příštím `analyze_inbox.py` runu se korekce zobrazí jako few-shot příklad

### Možnost B — přes CLI (přímá oprava, bez Gmail)

```bash
cd ~/Develop/nano-cone/cone

# Zobrazit posledních 10 klasifikací
python scripts/correct_label.py --recent 10

# Opravit konkrétní email (ID z výpisu)
python scripts/correct_label.py 1234 todo --note "Calendly odkaz"
python scripts/correct_label.py 1235 ignore
```

CLI okamžitě nastaví `correction=1`, `corrected_at`, `correction_note` a `status='corrected'`. Nepropaká se do Gmailu — label v Gmailu zůstane beze změny.

### Kdy použít kterou možnost

| Situace | Postup |
|---------|--------|
| Normální práce s emailem v Gmailu | Možnost A — je to přirozené, zero overhead |
| Dávková oprava více emailů najednou | Možnost B — `--recent 20` + opakované volání CLI |
| Burlak/Šiška chce opravit klasifikaci | Možnost B — cone-db MCP nebo přímý `correct_label.py` |
| Chceš přidat důvod ("proč jsem to opravil") | Možnost B — `--note "důvod"` |

---

## Sledování accuracy

```bash
# Correction rate za posledních 30 dní
python scripts/correction_stats.py --days 30

# JSON výstup (pro Burlak ANALYZE runy)
python scripts/correction_stats.py --days 7 --json
```

Výstup obsahuje:
- **Correction rate** — % emailů kde Karel nesouhlasil se systémem
- **Confusion matrix** — které `auto_label` se nejčastěji opravuje na co
- **Weekly trend** — zda se accuracy zlepšuje
- **Noted corrections** — korekce s vysvětlením (`--note`)

Ideální stav: correction rate < 5%, matice bez dominantního vzoru. Pokud jedna kategorie trvale selhává → upravit prompt v `analyze_inbox.py`.

---

## Soubory

| Soubor | Účel |
|--------|------|
| `cone/scripts/analyze_inbox.py` | LLM klasifikace → cone_inbox |
| `cone/scripts/auto_label_emails.py` | Detekce Gmail korekcí (`detect_overrides`) |
| `cone/scripts/correct_label.py` | CLI oprava labelu bez Gmail |
| `cone/scripts/correction_stats.py` | Accuracy statistiky a trend |
| `cone/scripts/process_cone_labels.py` | Zpracování Cone/* Gmail labelů → cone_inbox |
