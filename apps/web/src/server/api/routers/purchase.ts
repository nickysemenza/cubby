/**
 * Purchase Router — project spend ledger (migrated from Notion).
 * Pure crud-factory shape; no children, no rollups of its own.
 */

import { type PurchaseId, purchaseId } from "@cubby/schemas/identifiers";
import {
  purchaseAnalyticsInput,
  purchaseAnalyticsOut,
  purchaseBulkCostTypeInput,
  purchaseBulkMoveInput,
  purchaseBulkTradeInput,
  purchaseCreateInput,
  purchaseFiltersSchema,
  purchaseListAndSideEffectsOut,
  purchaseOut,
  purchaseSortableFields,
  purchaseUpdateData,
} from "@cubby/schemas/project";
import { z } from "zod";
import {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  movePurchases,
  purchaseAnalytics,
  purchaseList,
  setPurchasesCostType,
  setPurchasesTrade,
  updatePurchase,
} from "~/server/repo/purchase";
import { runMutationSideEffectsForEntities } from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const {
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
} = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: purchaseCreateInput,
    updateInput: purchaseUpdateData,
    output: purchaseOut,
    filters: purchaseFiltersSchema,
    sort: { sortableFields: purchaseSortableFields, defaultSort: "date" },
    idSchema: purchaseId,
  },
  repository: {
    getByID: async (services, id: PurchaseId) =>
      getPurchaseByID(services.db, id),
    list: async (services, filters, sort, pagination) =>
      purchaseList(services.db, filters, sort, pagination),
    create: async (services, data) =>
      createPurchase(services.db, data, services.actorContext),
    update: async (services, id: PurchaseId, data) =>
      updatePurchase(services.db, id, data, services.actorContext),
    delete: async (services, ids) => {
      await deletePurchases(services.db, ids, services.actorContext);
      return undefined;
    },
  },
  entityName: "purchase",
});

/**
 * Every purchase matching the filters, in one round trip — chart aggregates
 * happen client-side, and `list`'s 500-row page cap would silently truncate
 * them (same fetch-all convention as project.dashboard).
 */
const FETCH_ALL = { pageIndex: 0, pageSize: 100_000 };
const chartData = protectedProcedure
  .input(purchaseFiltersSchema)
  .output(z.array(purchaseOut))
  .query(async ({ ctx, input }) => {
    const { data } = await purchaseList(
      ctx.db,
      input,
      [{ orderBy: "date", direction: "asc" }],
      FETCH_ALL,
    );
    return data;
  });

/**
 * Server-side chart aggregates — grouped SQL sums/counts over the SAME
 * filter shape as `list`/`chartData`, replacing the client-side grouping
 * that ran over `chartData`'s fetch-all. See repo/purchase/analytics.ts for
 * the SQL; `chartData` stays in place for whatever else still fetches raw rows.
 */
const analytics = protectedProcedure
  .input(purchaseAnalyticsInput)
  .output(purchaseAnalyticsOut)
  .query(({ ctx, input }) => purchaseAnalytics(ctx.db, input));

// Bulk "move to project" — projectId: null moves every listed purchase to the
// inbox. Mirrors inventory.bulkMove/task.bulkMove's shape: one repo call
// inside a transaction, then one wave-wide runMutationSideEffectsForEntities
// so the embedding refresh for every moved purchase batches into a single
// dispatch.
const bulkMove = protectedProcedure
  .input(purchaseBulkMoveInput)
  .output(purchaseListAndSideEffectsOut)
  .mutation(async ({ ctx, input }) => {
    const items = await movePurchases(ctx.db, input, ctx.actorContext);
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      items.map((item) => ({
        action: "updated" as const,
        entity: { entityType: "purchase" as const, entityId: item.id },
        source: "purchase.bulkMove",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Bulk trade write, same wave-wide side-effect shape as bulkMove above.
const bulkSetTrade = protectedProcedure
  .input(purchaseBulkTradeInput)
  .output(purchaseListAndSideEffectsOut)
  .mutation(async ({ ctx, input }) => {
    const items = await setPurchasesTrade(ctx.db, input, ctx.actorContext);
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      items.map((item) => ({
        action: "updated" as const,
        entity: { entityType: "purchase" as const, entityId: item.id },
        source: "purchase.bulkSetTrade",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

// Bulk cost-type write, same shape as bulkSetTrade.
const bulkSetCostType = protectedProcedure
  .input(purchaseBulkCostTypeInput)
  .output(purchaseListAndSideEffectsOut)
  .mutation(async ({ ctx, input }) => {
    const items = await setPurchasesCostType(ctx.db, input, ctx.actorContext);
    const backgroundBatches = await runMutationSideEffectsForEntities(
      ctx.db,
      items.map((item) => ({
        action: "updated" as const,
        entity: { entityType: "purchase" as const, entityId: item.id },
        source: "purchase.bulkSetCostType",
      })),
    );
    return { items, sideEffects: { backgroundBatches } };
  });

export const purchaseRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
  chartData,
  analytics,
  bulkMove,
  bulkSetTrade,
  bulkSetCostType,
});
