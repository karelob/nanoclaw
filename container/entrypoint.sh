#!/bin/bash
set -e

# Shadow .env so the agent cannot read host secrets (requires root)
if [ "$(id -u)" = "0" ] && [ -f /workspace/project/.env ]; then
  mount --bind /dev/null /workspace/project/.env
fi

# Copy cone.db and embeddings.db to local /tmp so VirtioFS does not hold
# POSIX locks on the host file. This frees the host to write (sync scripts)
# while the container reads its own copy.
mkdir -p /workspace/local-db
if [ -f /workspace/extra/cone-db/cone.db ]; then
  cp /workspace/extra/cone-db/cone.db /tmp/cone.db 2>/dev/null && \
    mv /tmp/cone.db /workspace/local-db/cone.db && \
    umount /workspace/extra/cone-db 2>/dev/null || true
fi
if [ -f /workspace/extra/embeddings-db/embeddings.db ]; then
  cp /workspace/extra/embeddings-db/embeddings.db /tmp/embeddings.db 2>/dev/null && \
    mv /tmp/embeddings.db /workspace/local-db/embeddings.db || true
fi

# Compile agent-runner
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist

# Capture stdin (secrets JSON) to temp file
cat > /tmp/input.json

# Drop privileges if running as root (main-group containers)
if [ "$(id -u)" = "0" ] && [ -n "$RUN_UID" ]; then
  chown "$RUN_UID:$RUN_GID" /tmp/input.json /tmp/dist /workspace/local-db 2>/dev/null || true
  exec setpriv --reuid="$RUN_UID" --regid="$RUN_GID" --clear-groups -- node /tmp/dist/index.js < /tmp/input.json
fi

exec node /tmp/dist/index.js < /tmp/input.json
