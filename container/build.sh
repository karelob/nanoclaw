#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

# Copy cone-mcp into build context (pre-built dist + package files)
CONE_MCP_SRC="${SCRIPT_DIR}/../../cone-mcp"
CONE_MCP_DST="${SCRIPT_DIR}/cone-mcp"
rm -rf "${CONE_MCP_DST}"
mkdir -p "${CONE_MCP_DST}"
cp "${CONE_MCP_SRC}/package.json" "${CONE_MCP_SRC}/package-lock.json" "${CONE_MCP_DST}/" 2>/dev/null || true
cp -r "${CONE_MCP_SRC}/dist" "${CONE_MCP_DST}/"
echo "Copied cone-mcp to build context"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

# Clean up build context copy
rm -rf "${CONE_MCP_DST}"

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
