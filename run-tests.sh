#!/usr/bin/env bash
# Full gate for the MRP console. Run from the directory holding
# mrp-console_WORKING.jsx and the test files.
set -u
FILE=${1:-mrp-console_WORKING.jsx}

echo "=== syntax ==="
cp "$FILE" /tmp/_gate.tsx
echo "parse errors: $(tsc --noEmit --jsx preserve --target es2020 --skipLibCheck /tmp/_gate.tsx 2>&1 | grep -cE 'error TS1[0-7][0-9]{2}')"

echo
echo "=== extracting pure-logic core ==="
./mkcore.sh >/dev/null || { echo "mkcore failed"; exit 1; }

echo
echo "=== logic suites ==="
TOTAL=0; FAILED=0
for t in schema data-layer csv-codec timeseries scheduler calendar \
         plan-freeze cost purchasing reconciliation sales-orders held-stock; do
  R=$(node "$t.test.mjs" 2>&1 | grep -E "^  [0-9]+ passed, [0-9]+ failed")
  printf "  %-22s%s\n" "$t" "$R"
  TOTAL=$((TOTAL + $(echo "$R" | grep -oE '^[0-9]+')))
  FAILED=$((FAILED + $(echo "$R" | grep -oE '[0-9]+ failed' | grep -oE '^[0-9]+')))
done

echo
echo "=== render suite ==="
echo "  run separately from rendertest/ : node render.js"

echo
echo "TOTAL: $TOTAL logic assertions, $FAILED failed"
[ "$FAILED" -eq 0 ] || exit 1
