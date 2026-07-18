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
import {
  createPurchase,
  deletePurchases,
  getPurchaseByID,
  purchaseList,
  updatePurchase,
} from "~/server/repo/purchase";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  createDeleteProcedure,
  createEntityCrudProcedures,
} from "../crud-factory";
import { createTRPCRouter } from "../trpc";

const { getByID, list, create, update } = createEntityCrudProcedures({
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
    create: async (services, data) => {
      const created = await createPurchase(
        services.db,
        data,
        services.actorContext,
      );
      await runMutationSideEffects(services.db, {
        action: "created",
        entity: { entityType: "purchase", entityId: created.id },
        source: "purchase.create",
      });
      return created;
    },
    update: async (services, id: PurchaseId, data) => {
      const updated = await updatePurchase(
        services.db,
        id,
        data,
        services.actorContext,
      );
      await runMutationSideEffects(services.db, {
        action: "updated",
        entity: { entityType: "purchase", entityId: id },
        source: "purchase.update",
      });
      return updated;
    },
  },
  entityName: "purchase",
});

const deleteItem = createDeleteProcedure<PurchaseId>(async (services, ids) => {
  await deletePurchases(services.db, ids, services.actorContext);
  return undefined;
}, purchaseId);

export const purchaseRouter = createTRPCRouter({
  getByID,
  list,
  create,
  update,
  delete: deleteItem,
});
