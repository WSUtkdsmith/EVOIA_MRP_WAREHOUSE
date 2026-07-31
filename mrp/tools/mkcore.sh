#!/bin/bash
# Extract the pure-logic core (everything above the first React component)
# into a runnable ES module, so the data layer can be tested with node.
#
# Path-portable: resolves the MRP module root from this script's own location
# (mrp/tools/mkcore.sh -> mrp/) instead of a hardcoded working directory, and
# reads the canonical source file mrp-console.jsx. If you rename the source or
# move this script, only MRP_ROOT/SRC below need to change.
set -euo pipefail
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MRP_ROOT="$(dirname "$TOOLS_DIR")"
SRC="$MRP_ROOT/mrp-console.jsx"

END=$(grep -n "^/\* ---------------------------------------------------------------$" "$SRC" \
      | awk -F: '{print $1}' \
      | while read L; do
          if sed -n "$((L+1))p" "$SRC" | grep -q "Small shared UI atoms"; then echo $L; break; fi
        done)
sed -n "9,$((END-1))p" "$SRC" > /tmp/core.mjs
cat >> /tmp/core.mjs <<'EOF'

export { SCHEMA, ENTITIES, repo, tx, seedData, normalizeData, entityForItemType,
         exportCsvBundle, csvExportZip, collectRows, toCsv, csvEscape, serializeCell,
         bundleManifest, zipStore, crc32, IMPORT_ORDER, PROCESS_LOG_TABLES,
         importCsvBundle, parseCsvText, deserializeCell, csvPlan, buildIndex,
         bucketKeyOf, bucketLabelOf, bucketStartOf, enumerateBuckets, bucketEvents,
         productionEvents, receiptEvents, consumptionEvents, wasteEvents, batchEvents,
         shipmentEvents, orderCompletionEvents, dataDateSpan, resolvePreset,
         sellableToCustomer, shipmentUnitPrice, getEffectivePrice, shipmentLines,
         fulfilmentReconciliation, shipmentTrace, shippedFromLot,
         expectedUnitCost, normalizeShipments,
         salesOrderRecords, salesOrderLineDetail, salesRepSummary, soListPrice, SO_DECISIONS,
         materialFlowGraph, materialFlowColumns, stockAwarePlan, flowNodeKey,
         processGraph, coverageSummary,
         heldFinishedGoods, heldSummary, cancellationRecords, cancelledFromRun,
         CANCELLATION_REASONS, CANCELLATION_DISPOSITIONS,

         RANGE_PRESETS, GRANULARITIES, isoWeekParts, shiftISO,
         planVsActualEvents, fulfilledQtyOf, targetForBucket, withTargets,
         utilizationSeries, utilizationByEquipment, equipmentAvailableEvents,
         equipmentActualEvents, equipmentCommittedEvents, equipmentMaintenanceEvents,
         equipmentHoursOn,
         planScheduleFIFO, buildStageGraph, buildCapacity, capacityFree, earliestSlot,
         calendarHoursOn, stageHoursOn, stageWorkingDays, defaultCalendar, calendarFor,
         weeklyHours, calendarIsWorkable, ensureOperatingCalendars,
         activeOverride, resolveHours, normalizeEquipment,
         lotCost, lotProducedQty, itemActualUnitCost, batchRecords, allLotsWithOwner,
         unitsPerContainer, poPackaging, packagingLabel, qtyFromContainers, containersFromQty,
         poLines, poOrderedQty, poLineReceivedQty, poLineOutstanding, poLineCost,
         poLineContainerSummary,
         poTotalCost, poContainerSummary, rawStockOnHand, suggestPurchaseOrders,
         nextPoReference,
         purchaseOrderRecords, poReceivedQty, poOutstanding, poDerivedStatus, poDaysLate,
         poActualDate, openOrderQty, purchaseOrderedEvents, purchaseExpectedEvents,
         purchaseReceivedEvents,
         lotConversionHours, computeItemUnitCost,
         WEEKDAY_KEYS, WEEKDAY_LABELS,
         fifoOrder, calendarGrid, shiftMonth, monthLabel, datesInRange, daysBetweenISO,
         expandMaintenanceWindows, computeTimeline,
         allTables, csvColumns, parseColType, backfillRowIds,
         getWasteStreamForComponent, computeEffectiveComposition };
EOF
echo "core.mjs built from lines 9..$((END-1)) of $SRC"
