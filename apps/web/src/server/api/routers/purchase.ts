/**
 * Purchase Router — project spend ledger (migrated from Notion).
 * Pure crud-factory shape; no children, no rollups of its own.
 */

import { type PurchaseId, purchaseId } from "@cubby/schemas/identifiers";
import {
  purchaseBulkMoveInput,
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
  purchaseList,
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

export const purchaseRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
  chartData,
  bulkMove,
});
