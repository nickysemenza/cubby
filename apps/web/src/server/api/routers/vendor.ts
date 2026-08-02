/**
 * Vendor Router — the roster of places money goes.
 *
 * `list` comes from the shared factory; the rest is hand-rolled because
 * `vendorOut` carries correlated rollups (`purchaseCount`, `spend`) the
 * factory's plain column reader can't produce.
 */

import { unsafeVendorId, vendorShortcode } from "@cubby/schemas/identifiers";
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
import { createAppError } from "~/server/errors/app-error";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  createVendor,
  deleteVendors,
  getVendorByID,
  getVendorByShortcode,
  mergeVendors,
  updateVendor,
  vendorList,
  vendorOptions,
} from "~/server/repo/vendor";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import {
  createEntityListProcedure,
  createGetByShortcodeProcedure,
} from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

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
  .input(vendorShortcode)
  .output(strictOutput(vendorOut))
  .query(async ({ ctx, input }) => {
    const id = await resolveLiveShortcode(ctx.db, input, "vendor");
    if (!id) {
      throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${input}`);
    }
    return getVendorByID(ctx.db, unsafeVendorId(id));
  });

const getByShortcode = createGetByShortcodeProcedure(
  "vendor",
  vendorOut,
  (ctx, shortcode) => getVendorByShortcode(ctx.db, shortcode),
);

/**
 * The vendor picklist — feeds the ledger's Vendor filter and the purchase form's
 * combobox. Cheap options query, same shape as `project.options`.
 */
const options = protectedProcedure
  .output(strictOutput(vendorOptionsOut))
  .query(({ ctx }) => vendorOptions(ctx.db));

const create = protectedProcedure
  .input(vendorCreateInput)
  .output(strictOutput(vendorOut))
  .mutation(async ({ ctx, input }) => {
    const result = await createVendor(ctx.db, input, ctx.actorContext);
    await runMutationSideEffects(ctx.db, {
      action: "created",
      entity: { entityType: "vendor", entityId: result.entityId },
      source: "vendor.create",
    });
    return result.output;
  });

const update = protectedProcedure
  .input(vendorUpdateInput)
  .output(strictOutput(vendorOut))
  .mutation(async ({ ctx, input }) => {
    const result = await updateVendor(ctx.db, input, ctx.actorContext);
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "vendor", entityId: result.entityId },
      source: "vendor.update",
    });
    return result.output;
  });

/**
 * Fold duplicate roster rows into one. Charges follow the keeper; any two charges
 * sharing an order id across the merged vendors are themselves folded, since the
 * partial-unique `(vendorId, orderId)` index means only one can survive — see
 * `mergeVendors`.
 */
const merge = protectedProcedure
  .input(mergeVendorsInput)
  .output(strictOutput(vendorOut))
  .mutation(async ({ ctx, input }) => {
    const output = await mergeVendors(ctx.db, input, ctx.actorContext);
    const entityId = await resolveLiveShortcode(ctx.db, output.id, "vendor");
    if (entityId) {
      await runMutationSideEffects(ctx.db, {
        action: "updated",
        entity: { entityType: "vendor", entityId: unsafeVendorId(entityId) },
        source: "vendor.merge",
      });
    }
    return output;
  });

const deleteItem = protectedProcedure
  .input(z.object({ ids: z.array(vendorShortcode).min(1) }))
  .mutation(async ({ ctx, input }) => {
    await deleteVendors(ctx.db, input.ids, ctx.actorContext);
  });

export const vendorRouter = createTRPCRouter({
  getByID,
  getByShortcode,
  list,
  options,
  create,
  update,
  merge,
  delete: deleteItem,
});
