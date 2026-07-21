/**
 * Purchase Router — project spend ledger (migrated from Notion).
 * Pure crud-factory shape; no children, no rollups of its own.
 */

import { type PurchaseId, purchaseId } from "@cubby/schemas/identifiers";
import {
  purchaseCreateInput,
  purchaseFiltersSchema,
  purchaseOut,
  purchaseSortableFields,
  purchaseUpdateData,
} from "@cubby/schemas/project";
import { z } from "zod";
import {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  purchaseList,
  updatePurchase,
} from "~/server/repo/purchase";
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

export const purchaseRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
  chartData,
});
