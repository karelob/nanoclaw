#!/bin/bash
# Ollama health check — runs as separate launchd job (not child of NanoClaw)
# NanoClaw's Node.js process can't reach LAN IPs due to vmnet sandbox
OLLAMA_URL="http://10.0.10.70:11434"
OUT_FILE="/tmp/ollama-check.json"

resp=$(/usr/bin/curl -s --connect-timeout 5 --max-time 8 "${OLLAMA_URL}/api/tags" 2>/dev/null)
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if echo "$resp" | grep -q "models"; then
  echo "{\"ok\":true,\"ts\":\"${ts}\"}" > "$OUT_FILE"
else
  echo "{\"ok\":false,\"ts\":\"${ts}\",\"err\":\"no response or no models\"}" > "$OUT_FILE"
fi
