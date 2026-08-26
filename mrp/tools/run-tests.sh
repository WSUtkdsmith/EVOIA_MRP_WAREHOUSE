#!/usr/bin/env bash
# Full gate for the MRP console. Path-portable: resolves the MRP module root
# from this script's own location, so it runs from any working directory and
# in CI, not just the original author's machine.
#
#   ./mrp/tools/run-tests.sh            # syntax + 12 logic suites
#   SKIP_TSC=1 ./mrp/tools/run-tests.sh # logic suites only (no typescript needed)
#
# The render suite (react-dom/server) is run separately from mrp/test/rendertest.
set -u
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MRP_ROOT="$(dirname "$TOOLS_DIR")"
SRC="${1:-$MRP_ROOT/mrp-console.jsx}"

if [ "${SKIP_TSC:-0}" != "1" ] && command -v tsc >/dev/null 2>&1; then
  echo "=== syntax ==="
  cp "$SRC" /tmp/_gate.tsx
  echo "parse errors: $(tsc --noEmit --jsx preserve --target es2020 --skipLibCheck /tmp/_gate.tsx 2>&1 | grep -cE 'error TS1[0-7][0-9]{2}')"
  echo
else
  echo "=== syntax === (skipped: tsc not available or SKIP_TSC=1)"
  echo
fi

echo "=== extracting pure-logic core ==="
"$TOOLS_DIR/mkcore.sh" >/dev/null || { echo "mkcore failed"; exit 1; }

echo
echo "=== logic suites ==="
TOTAL=0; FAILED=0
for t in schema data-layer csv-codec timeseries scheduler calendar \
         plan-freeze cost purchasing reconciliation sales-orders held-stock packaging \
         purchase-planning receipt-apply material-flow batch-runs sales-linking; do
  R=$(node "$MRP_ROOT/test/$t.test.mjs" 2>&1 | grep -E "^ *[0-9]+ passed, [0-9]+ failed")
  printf "  %-22s%s\n" "$t" "$R"
  P=$(echo "$R" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')
  F=$(echo "$R" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+')
  TOTAL=$((TOTAL + ${P:-0}))
  FAILED=$((FAILED + ${F:-0}))
done

echo
echo "=== render suite ==="
echo "  npm run test:render  (mrp/tools/mkapp.sh + mrp/test/render.test.js)"

echo
echo "TOTAL: $TOTAL logic assertions, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
