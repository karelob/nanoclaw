#!/bin/bash
# Session start hook: injects active context on session start/resume
# Location: ~/Develop/nano-cone/nanoclaw/.claude/hooks/session-start.sh
# Triggered by: SessionStart event in .claude/settings.json

KNOWLEDGE_DIR="$HOME/Develop/nano-cone/knowledge"
ACTIVE_SESSION="$KNOWLEDGE_DIR/active_session.md"

# Only inject active session if it exists and has content beyond template
if [ -f "$ACTIVE_SESSION" ]; then
    LINES=$(wc -l < "$ACTIVE_SESSION" | tr -d ' ')
    if [ "$LINES" -gt 10 ]; then
        echo "## Resuming — Active Session Context"
        cat "$ACTIVE_SESSION"
        echo ""
        echo "---"
    fi
fi

# Check for urgent @cli items
if [ -f "$KNOWLEDGE_DIR/tracking/system_health.md" ]; then
    URGENT=$(grep -c "@cli.*\[ \]" "$KNOWLEDGE_DIR/tracking/system_health.md" 2>/dev/null || echo "0")
    if [ "$URGENT" -gt 0 ]; then
        echo "⚠️ $URGENT unclaimed @cli action items in system_health.md — check immediately"
    fi
fi
