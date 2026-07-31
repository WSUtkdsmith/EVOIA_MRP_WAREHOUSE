# EVWB Changelog

## Revision 174 – Rollback documentation (2026-07-14)

**Incident:** The commit tagged `Revision 173 – Reconciliation panel layout and overflow fix` (`e26fd66`) unintentionally replaced `index.html` with an incomplete ~8KB stub (CSS/header shell only, missing the app's JavaScript and panel markup). This broke the production deployment on Vercel — the live app rendered blank/non-functional.

**Fix:** Devin restored the full working app by committing `Update index.html` (`4008008`), which reinstated the complete, working Revision 172 build. Vercel auto-deployed this commit to production immediately. Verified live at [evoia-warehouse-builder.vercel.app](https://evoia-warehouse-builder.vercel.app) — the Master Warehouse Map and all panels (Open Floor, Plant Storage, Shipping/Receiving, Build Slot, Main Storage, Empty Tote Overflow, Barrel Storage) render correctly.

**Rollback safety:** Commit `4008008` is tagged `stable-172-restore` for easy recovery if a future change breaks the app again.

**Going forward:** Next new feature/fix work continues numbering from **Revision 174**.

---

## Revision 173 – Reconciliation panel layout and overflow fix (`e26fd66`)

Intended to fix reconciliation panel width/scroll behavior. Introduced a regression that broke the production build (see incident note above). Superseded by the Revision 172 restore in commit `4008008`.

## Revision 172 and earlier

No changelog entries recorded prior to this file being introduced. Baseline app functionality (position tracking, pallet management, receiving/shipping, reconciliation) established across earlier commits.
