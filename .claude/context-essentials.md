# Post-Compaction Context Recovery

⚠️ CONTEXT WAS COMPACTED. Read this carefully before continuing.

## Who You Are
CLI agent working with Karel Obluk in ~/Develop/nano-cone/nanoclaw.
Karel is entrepreneur, investor, president of CBAA.

## Immediate Actions After Compaction
1. Read `knowledge/active_session.md` — current work context
2. Read `knowledge/situation.md` (last 30 lines) — Agent Log
3. Read `knowledge/tracking/system_health.md` — pending @cli items
4. DO NOT ask Karel to repeat what we were working on

## Critical Rules (always apply)
- NEVER blame network/intermittent issues — find root cause
- NEVER merge Burlak branches without Karel's explicit approval
- Evolution data → ONLY Ollama (10.0.10.70) or Claude Enterprise
- Emails → ONLY to karel@obluk.com or karel@obluk.name
- Tool risk tiers: read CLAUDE.md for full list

## Memory Discipline
After EVERY completed task, update `knowledge/active_session.md`:
- New facts → "Key Facts" section
- Decisions → "Recent Decisions" section  
- Open threads → update status
- Run: `cat knowledge/active_session.md` to verify state

## Key Paths
- Knowledge repo: ~/Develop/nano-cone/knowledge/
- Cone DB (MCP): cone-db tools (14 tools)
- System health: knowledge/tracking/system_health.md
- Agent comms: knowledge/situation.md (Agent Log at bottom)
