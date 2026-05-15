#!/usr/bin/env bash
# Rebuild the OpenClaw tarball from the current project state
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENCLAW_SKILL="$HOME/.openclaw/workspace/skills/12306-booking"
DIST="$PROJECT_ROOT/12306-booking.tar.gz"

echo "🚄 Rebuilding OpenClaw skill tarball..."

# 1. Sync booking.js (single source of truth)
cp "$PROJECT_ROOT/scripts/booking.js" "$OPENCLAW_SKILL/scripts/booking.js"

# 2. Sync SKILL.md from Pi skill (single source of truth)
cp "$PROJECT_ROOT/.pi/skills/12306-booking/SKILL.md" "$OPENCLAW_SKILL/SKILL.md"

# 3. Rebuild tarball (exclude node_modules, .env, cookies)
cd "$(dirname "$OPENCLAW_SKILL")"
tar czf "$DIST" \
  --exclude='node_modules' \
  --exclude='package-lock.json' \
  12306-booking/

echo "✅ Done: $DIST ($(du -h "$DIST" | cut -f1))"
tar tzf "$DIST"
