#!/bin/bash
# Extract the pure-logic core (everything above the first React component)
# into a runnable ES module, so the data layer can be tested with node.
cd /home/claude/work
END=$(grep -n "^/\* ---------------------------------------------------------------$" mrp-console_WORKING.jsx \
      | awk -F: '{print $1}' \
      | while read L; do
          if sed -n "$((L+1))p" mrp-console_WORKING.jsx | grep -q "Small shared UI atoms"; then echo $L; break; fi
        done)
sed -n "9,$((END-1))p" mrp-console_WORKING.jsx > /tmp/core.mjs
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
echo "core.mjs built from lines 9..$((END-1))"
