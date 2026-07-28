/**
 * Purchase repository — public API barrel.
 *
 * A Purchase is a spend, usually attached to a Project (nullable `projectId`).
 * See packages/schemas/src/project.ts for the domain doc comment. Import
 * purchase operations from `~/server/repo/purchase` (this barrel).
 *
 *   CRUD      → `crud.ts`      (create / delete hand-rolled; get/update go
 *                                through `createEntityCrud` — no dependency
 *                                edges, no rollups, so the shared factory
 *                                fits directly)
 *   LOOKUP    → `lookup.ts`    (filtered/sorted/paginated list; also exports
 *                                `buildPurchaseWhereClause` for `analytics.ts`
 *                                to import directly — not re-exported here,
 *                                it's an internal sibling seam, not a public
 *                                barrel surface)
 *   ANALYTICS → `analytics.ts` (server-side grouped SQL aggregates for charts)
 *
 * Sibling relationships: `purchase.projectId` references `project` (feeds its
 * `spent`/`purchaseCount` rollup — see project/analytics.ts). `helpers.ts`
 * (row→API mapping) is internal.
 */

export { purchaseAnalytics, purchaseTradeAffinity } from "./analytics";
export {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  movePurchases,
  setPurchasesCostType,
  setPurchasesTrade,
  updatePurchase,
} from "./crud";
export { purchaseList } from "./lookup";
