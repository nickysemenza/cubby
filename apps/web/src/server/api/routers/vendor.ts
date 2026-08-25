/**
 * Vendor Router — the roster of places money goes.
 *
 * Standard CRUD comes from the shared searchable factory; `options` and `merge`
 * are the only procedures with no factory analogue and are spread in alongside.
 */

import {
  fetchVendorLogoInput,
  mergeVendorsInput,
  mergeVendorsOut,
  vendorOptionsOut,
  vendorOut,
} from "@cubby/schemas/vendor";
import { ENTITY_BINDINGS } from "~/server/entity-bindings";
import { executeEntity } from "~/server/entity-kernel";
import { ENTITY_KERNEL_BINDINGS } from "~/server/generated/entity-kernel-bindings.gen";
import { vendorOptions } from "~/server/repo/vendor";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { fetchAndAttachVendorLogo } from "~/server/services/vendor-logo.service";
import { createEntityListCompatibilityProcedure } from "../entity-compatibility";
import { createTRPCRouter, protectedProcedure, strictOutput } from "../trpc";

const list = createEntityListCompatibilityProcedure(
  ENTITY_KERNEL_BINDINGS.vendor,
  ENTITY_BINDINGS.vendor.crud,
);

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
    const result = await executeEntity(ctx, {
      action: "merge",
      entity: "vendor",
      data: input,
    });
    if (result.action !== "merge")
      throw new Error("Entity kernel returned the wrong action");
    return mergeVendorsOut.parse({
      vendor: result.item,
      mergeSummary: result.mergeSummary,
    });
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
  list,
  options,
  merge,
  fetchLogo,
});
