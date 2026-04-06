#!/bin/bash
# Pre-compaction hook: reminds agent to save state before compaction
# Location: ~/Develop/nano-cone/nanoclaw/.claude/hooks/pre-compact.sh
# Triggered by: PreCompact event in .claude/settings.json
#
# This outputs a reminder that gets injected before compaction happens.
# The agent should then write to active_session.md before context is lost.

KNOWLEDGE_DIR="$HOME/Develop/nano-cone/knowledge"
ACTIVE_SESSION="$KNOWLEDGE_DIR/active_session.md"

echo "⚠️ COMPACTION IMMINENT — SAVE SESSION STATE NOW"
echo ""
echo "Before compaction proceeds, you MUST update $ACTIVE_SESSION with:"
echo "1. Current Focus — what are we working on right now?"
echo "2. Open Threads — status of all active topics"
echo "3. Recent Decisions — any decisions made this session"  
echo "4. Key Facts — anything established that would be lost"
echo "5. Pending Questions — unresolved items"
echo ""
echo "Current active_session.md content:"
echo "---"
if [ -f "$ACTIVE_SESSION" ]; then
    cat "$ACTIVE_SESSION"
else
    echo "(file does not exist — create it!)"
fi
echo "---"
echo ""
echo "UPDATE active_session.md NOW, then compaction can proceed."
