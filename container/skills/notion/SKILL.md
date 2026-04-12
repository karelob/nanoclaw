---
name: notion
description: Jednorázový přístup k Notion — čtení a zápis databází a stránek přes přímé API volání. Bez MCP serveru.
---

# /notion — Notion API

Přímý přístup k Notion přes REST API. Bez MCP serveru.

## Token

```bash
NOTION_TOKEN=$(grep '^NOTION_TOKEN=' /workspace/extra/cone-config/.env | cut -d= -f2-)
```

## Základní operace

### Query databáze
```bash
curl -s "https://api.notion.com/v1/databases/{DB_ID}/query" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X POST -d '{}' | python3 -m json.tool
```

### Přečíst stránku
```bash
curl -s "https://api.notion.com/v1/pages/{PAGE_ID}" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28"
```

### Hledat
```bash
curl -s "https://api.notion.com/v1/search" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X POST -d '{"query": "hledaný text"}'
```

### Aktualizovat stránku / přidat vlastnost
```bash
curl -s "https://api.notion.com/v1/pages/{PAGE_ID}" \
  -H "Authorization: Bearer $NOTION_TOKEN" \
  -H "Notion-Version: 2022-06-28" \
  -H "Content-Type: application/json" \
  -X PATCH -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'
```

## Existující Python skripty (cone)

Pro složitější operace použij přímo:

```bash
# Sync Notion "Pro šišku" inbox → cone.db tabulka notion_inbox
python3 /workspace/extra/cone-scripts/sync_notion_inbox.py

# Obohacení kontaktů z Notion "Lidi" DB → cone.db facts
python3 /workspace/extra/cone-scripts/enrich_notion_people.py

# Generální import
python3 /workspace/extra/cone-scripts/import_notion.py
```

## Klíčové DB IDs (z kódu)

- Lidi DB: `15edaf56-e3e5-8067-92ee-d332ba7005c5`
- Pro šišku inbox: zjisti z sync_notion_inbox.py (NOTION_DATABASE_ID)
