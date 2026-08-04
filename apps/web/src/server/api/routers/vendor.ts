/**
 * Vendor Router — the roster of places money goes.
 *
 * Standard CRUD comes from the shared searchable factory; `options` and `merge`
 * are the only procedures with no factory analogue and are spread in alongside.
 */

import {
  unsafeVendorId,
  unsafeVendorShortcode,
  vendorShortcode,
} from "@cubby/schemas/identifiers";
import {
  mergeVendorsInput,
  vendorCreateInput,
  vendorFiltersSchema,
  vendorOptionsOut,
  vendorOut,
  vendorSortableFields,
  vendorUpdateData,
} from "@cubby/schemas/vendor";
import { createAppError } from "~/server/errors/app-error";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import {
  createVendor,
  deleteVendors,
  getVendorByShortcode,
  mergeVendors,
  updateVendor,
  vendorList,
  vendorOptions,
} from "~/server/repo/vendor";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const procedures = createSearchableEntityCrudProcedures({
  schemas: {
    createInput: vendorCreateInput,
    updateInput: vendorUpdateData,
    output: vendorOut,
    filters: vendorFiltersSchema,
    sort: {
      sortableFields: vendorSortableFields,
      defaultSort: "name",
    },
    idSchema: vendorShortcode,
  },
  repository: {
    getByID: async (ctx, id) => {
      const out = await getVendorByShortcode(ctx.db, id);
      if (!out) {
        throw createAppError("VENDOR_NOT_FOUND", `Vendor not found: ${id}`);
      }
      return out;
    },
    getByShortcode: (ctx, shortcode) => getVendorByShortcode(ctx.db, shortcode),
    list: (ctx, filters, sorts, pagination) =>
      vendorList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createVendor(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) =>
      updateVendor(
        ctx.db,
        { id: unsafeVendorShortcode(id), data },
        ctx.actorContext,
      ),
    delete: async (ctx, ids) => {
      await deleteVendors(
        ctx.db,
        ids.map(unsafeVendorShortcode),
        ctx.actorContext,
      );
      return [];
    },
  },
  entityName: "vendor",
});

/**
 * The vendor picklist — feeds the ledger's Vendor filter and the purchase form's
 * combobox. Cheap options query, same shape as `project.options`.
 */
const options = protectedProcedure
  .output(strictOutput(vendorOptionsOut))
  .query(({ ctx }) => vendorOptions(ctx.db));

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

export const vendorRouter = createTRPCRouter({
  ...procedures,
  options,
  merge,
});
