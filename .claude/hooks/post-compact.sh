#!/bin/bash
# Post-compaction hook: injects critical context after compaction
# Location: ~/Develop/nano-cone/nanoclaw/.claude/hooks/post-compact.sh
# Triggered by: PostToolUse matcher "compact" in .claude/settings.json
#
# stdout is injected as system message into Claude's fresh context

KNOWLEDGE_DIR="$HOME/Develop/nano-cone/knowledge"
ESSENTIALS="$HOME/Develop/nano-cone/nanoclaw/.claude/context-essentials.md"

# 1. Static essentials (rules, paths, identity)
if [ -f "$ESSENTIALS" ]; then
    cat "$ESSENTIALS"
fi

echo ""
echo "---"
echo ""

# 2. Dynamic session context
if [ -f "$KNOWLEDGE_DIR/active_session.md" ]; then
    echo "## Current Session State (from active_session.md)"
    cat "$KNOWLEDGE_DIR/active_session.md"
else
    echo "## ⚠️ No active_session.md found — ask Karel what we're working on"
fi

echo ""
echo "---"
echo ""

# 3. Last 25 lines of Agent Log (inter-agent comms)
if [ -f "$KNOWLEDGE_DIR/situation.md" ]; then
    echo "## Recent Agent Log (last 25 lines of situation.md)"
    tail -25 "$KNOWLEDGE_DIR/situation.md"
fi

echo ""
echo "---"
echo ""

# 4. Pending @cli action items from system_health.md
if [ -f "$KNOWLEDGE_DIR/tracking/system_health.md" ]; then
    CLI_ITEMS=$(grep -A1 "@cli" "$KNOWLEDGE_DIR/tracking/system_health.md" | head -20)
    if [ -n "$CLI_ITEMS" ]; then
        echo "## Pending @cli Action Items"
        echo "$CLI_ITEMS"
    fi
fi
