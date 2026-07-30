/**
 * Vendor Router — the roster of places money goes.
 *
 * `list` comes from the shared factory; the rest is hand-rolled rather than
 * going through the full crud factory for two reasons: `vendorOut` carries two
 * correlated rollups (`purchaseCount`, `spend`) the factory's plain column
 * reader can't produce, and vendor is NOT searchable in v1, so the
 * searchable-crud factory's embedding side-effects would be wrong here.
 */

import { vendorId } from "@cubby/schemas/identifiers";
import {
  mergeVendorsInput,
  vendorCreateInput,
  vendorFiltersSchema,
  vendorOptionsOut,
  vendorOut,
  vendorSortableFields,
  vendorUpdateInput,
} from "@cubby/schemas/vendor";
import { z } from "zod";
import {
  createVendor,
  deleteVendors,
  getVendorByID,
  mergeVendors,
  updateVendor,
  vendorList,
  vendorOptions,
} from "~/server/repo/vendor";
import { createEntityListProcedure } from "../crud-factory";
import { createTRPCRouter, protectedProcedure } from "../trpc";

const { list } = createEntityListProcedure({
  schemas: {
    output: vendorOut,
    filters: vendorFiltersSchema,
    sort: {
      sortableFields: vendorSortableFields,
      defaultSort: "name",
    },
  },
  repository: {
    list: (ctx, filters, sorts, pagination) =>
      vendorList(ctx.db, filters, sorts, pagination),
  },
  entityName: "vendor",
});

const getByID = protectedProcedure
  .input(vendorId)
  .output(vendorOut)
  .query(({ ctx, input }) => getVendorByID(ctx.db, input));

/**
 * The vendor picklist — feeds the ledger's Vendor filter and the purchase form's
 * combobox. Cheap options query, same shape as `project.options`.
 */
const options = protectedProcedure
  .output(vendorOptionsOut)
  .query(({ ctx }) => vendorOptions(ctx.db));

const create = protectedProcedure
  .input(vendorCreateInput)
  .output(vendorOut)
  .mutation(({ ctx, input }) => createVendor(ctx.db, input, ctx.actorContext));

const update = protectedProcedure
  .input(vendorUpdateInput)
  .output(vendorOut)
  .mutation(({ ctx, input }) => updateVendor(ctx.db, input, ctx.actorContext));

/**
 * Fold duplicate roster rows into one. Charges follow the keeper; any two charges
 * sharing an order id across the merged vendors are themselves folded, since the
 * partial-unique `(vendorId, orderId)` index means only one can survive — see
 * `mergeVendors`.
 */
const merge = protectedProcedure
  .input(mergeVendorsInput)
  .output(vendorOut)
  .mutation(({ ctx, input }) => mergeVendors(ctx.db, input, ctx.actorContext));

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(vendorId).min(1) }))
  .mutation(async ({ ctx, input }) => {
    await deleteVendors(ctx.db, input.ids, ctx.actorContext);
  });

export const vendorRouter = createTRPCRouter({
  getByID,
  list,
  options,
  create,
  update,
  merge,
  delete: deleteItem,
});
