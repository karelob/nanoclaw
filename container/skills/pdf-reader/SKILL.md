---
name: pdf-reader
description: Čtení PDF souborů — extrakce textu z lokálních souborů, URL, nebo příloh. Používá pdftotext (poppler-utils).
---
Čtení a extrakce textu z PDF souborů.

## Použití

```bash
# Lokální soubor
pdftotext /cesta/k/souboru.pdf -

# S layout zachováním (tabulky, sloupce)
pdftotext -layout /cesta/k/souboru.pdf -

# Jen konkrétní stránky
pdftotext -f 1 -l 5 /cesta/k/souboru.pdf -

# Info o PDF (počet stran, velikost)
pdfinfo /cesta/k/souboru.pdf

# Stažení PDF z URL
curl -sL "URL" -o /tmp/dokument.pdf && pdftotext /tmp/dokument.pdf -
```

## Kde hledat PDF soubory

- `/workspace/local-db/` — cone.db (documents tabulka má file_path)
- `/workspace/extra/knowledge/` — knowledge repo
- Přílohy z Telegramu — `attachments/` v pracovním adresáři
- GDrive — stáhnout přes finance skill (gdrive_finance.py)

## Omezení

- Pouze textové PDF — skenované (obrázkové) PDF vrátí prázdný text
- Pro skenované PDF použij OCR nebo agent-browser pro vizuální analýzu
