/**
 * Vendor Router — the roster of places money goes.
 *
 * Standard CRUD comes from the shared searchable factory; `options` and `merge`
 * are the only procedures with no factory analogue and are spread in alongside.
 */

import { unsafeVendorId } from "@cubby/schemas/identifiers";
import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorFiltersSchema,
  vendorOptionsOut,
  vendorOut,
  vendorSortableFields,
} from "@cubby/schemas/vendor";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
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
import { deleteStoredObjects } from "~/server/services/image-storage.service";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { fetchAndAttachVendorLogo } from "~/server/services/vendor-logo.service";
import { createSearchableEntityCrudProcedures } from "../crud-factory";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const procedures = createSearchableEntityCrudProcedures({
  schemas: {
    ...ENTITY_BINDINGS.vendor.crud,
    filters: vendorFiltersSchema,
    sort: {
      sortableFields: vendorSortableFields,
      defaultSort: "name",
    },
  },
  repository: {
    getByShortcode: (ctx, shortcode) => getVendorByShortcode(ctx.db, shortcode),
    list: (ctx, filters, sorts, pagination) =>
      vendorList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createVendor(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updateVendor(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) => deleteVendors(ctx.db, ids, ctx.actorContext),
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
  .output(strictOutput(mergeVendorsOut))
  .mutation(async ({ ctx, input }) => {
    const { vendor, detachedImageKeys, mergeSummary } = await mergeVendors(
      ctx.db,
      input,
      ctx.actorContext,
    );
    await deleteStoredObjects(detachedImageKeys);
    const entityId = await resolveLiveShortcode(ctx.db, vendor.id, "vendor");
    if (entityId) {
      await runMutationSideEffects(ctx.db, {
        action: "updated",
        entity: { entityType: "vendor", entityId: unsafeVendorId(entityId) },
        source: "vendor.merge",
      });
    }
    return { vendor, mergeSummary };
  });

/** Explicitly source one missing logo from the vendor website on record. */
const fetchLogo = protectedProcedure
  .input(fetchVendorLogoInput)
  .output(strictOutput(vendorOut))
  .mutation(async ({ ctx, input }) => {
    const { output, entityId } = await fetchAndAttachVendorLogo(
      ctx.db,
      input.id,
      ctx.actorContext,
    );
    await runMutationSideEffects(ctx.db, {
      action: "updated",
      entity: { entityType: "vendor", entityId },
      source: "vendor.fetchLogo",
    });
    return output;
  });

export const vendorRouter = createTRPCRouter({
  ...procedures,
  options,
  merge,
  fetchLogo,
});
