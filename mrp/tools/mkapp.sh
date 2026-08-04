#!/bin/bash
# Build the render harness: mrp/test/app.js, a CommonJS bundle of the console
# that exports its components by name so react-dom/server can draw them.
#
# Why this exists
# ---------------
# The logic suites test pure functions, which is most of the risk but not all
# of it. A component that references a function someone deleted parses fine,
# passes every logic test, and then throws the moment it is drawn. That is
# exactly what blanked the warehouse map, and nothing in mkcore.sh's world can
# see it — the pure core stops at the first React component.
#
# mrp/test/render.test.js has covered this since Phase 0, but the bundle it
# requires was never committed, so the suite has been dead the whole time. This
# rebuilds it.
#
#   ./mrp/tools/mkapp.sh && node mrp/test/render.test.js
#
# The export list is derived from the test file's own `A.<name>` references, so
# adding a component to the test is all it takes to have it exported. A name
# that does not exist fails the bundle loudly rather than testing nothing —
# same contract as the warehouse's extract-by-name harness.
set -euo pipefail
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MRP_ROOT="$(dirname "$TOOLS_DIR")"
REPO_ROOT="$(dirname "$MRP_ROOT")"
SRC="$MRP_ROOT/mrp-console.jsx"
TEST="$MRP_ROOT/test/render.test.js"
OUT="$MRP_ROOT/test/app.js"

ESBUILD="$REPO_ROOT/node_modules/.bin/esbuild"
[ -x "$ESBUILD" ] || { echo "esbuild not installed - run npm install" >&2; exit 1; }

NAMES=$(grep -o 'A\.[A-Za-z_][A-Za-z0-9_]*' "$TEST" | sed 's/^A\.//' | sort -u | paste -sd, -)
[ -n "$NAMES" ] || { echo "no A.<name> references found in $TEST" >&2; exit 1; }

# The staging copy has to sit inside the repo, not /tmp: esbuild resolves
# lucide-react relative to the entry file, and from /tmp there is no
# node_modules to walk up to.
STAGE="$MRP_ROOT/.render-harness.jsx"
trap 'rm -f "$STAGE"' EXIT
cp "$SRC" "$STAGE"
printf '\nexport { %s };\n' "$NAMES" >> "$STAGE"

# react/react-dom stay external so the test and the bundle share one React
# instance - two copies would fail in ways that have nothing to do with the code
# under test.
#
# lucide-react is bundled from node_modules rather than from the Proxy stub in
# mrp/test/rendertest: esbuild resolves named imports statically, and a Proxy
# has no statically visible keys, so every icon would come through as undefined
# and every component would fail to construct for a reason that has nothing to
# do with the code under test. The real package is a devDependency and needs no
# network, so there is nothing to gain from the stub here.
"$ESBUILD" "$STAGE" \
  --bundle --format=cjs --platform=node \
  --external:react --external:react-dom \
  --define:process.env.NODE_ENV='"development"' \
  --outfile="$OUT" >/dev/null

echo "built $OUT ($(grep -c '' "$OUT") lines, $(echo "$NAMES" | tr ',' '\n' | grep -c '') exports)"
