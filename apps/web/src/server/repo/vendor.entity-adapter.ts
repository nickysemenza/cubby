import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mergeVendorsInput,
  mergeVendorsOut,
  vendorSortableFields,
} from "@cubby/schemas/vendor";

import { defineEntityAdapter } from "~/server/entity-kernel/adapter";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

import {
  createVendor,
  deleteVendors,
  getVendorByShortcode,
  mergeVendors,
  updateVendor,
  VENDOR_DELETE_EDGE_POLICY,
  VENDOR_MERGE_EDGE_POLICY,
  vendorList,
} from "./vendor";

export const vendorEntityAdapter = defineEntityAdapter({
  entity: "vendor",
  sort: { fields: vendorSortableFields, default: "name" },
  lifecycle: {
    delete: VENDOR_DELETE_EDGE_POLICY,
    merge: VENDOR_MERGE_EDGE_POLICY,
  },
  repository: {
    get: (ctx, id) => getVendorByShortcode(ctx.db, id),
    list: (ctx, filters, sorts, pagination) =>
      vendorList(ctx.db, filters, sorts, pagination),
    create: (ctx, data) => createVendor(ctx.db, data, ctx.actorContext),
    update: (ctx, id, data) => updateVendor(ctx.db, id, data, ctx.actorContext),
    delete: (ctx, ids) => deleteVendors(ctx.db, ids, ctx.actorContext),
  },
  merge: {
    input: mergeVendorsInput,
    output: mergeVendorsOut,
    item: (output) => output.vendor,
    summary: (output) => output.mergeSummary,
    execute: async (ctx, input) => {
      const { vendor, detachedImageKeys, mergeSummary } = await mergeVendors(
        ctx.db,
        input,
        ctx.actorContext,
      );
      const entityId = await resolveLiveShortcode(ctx.db, vendor.id, "vendor");
      return {
        output: { vendor, mergeSummary },
        entityId: entityId ? parseEntityId("vendor", entityId) : null,
        detachedImageKeys,
      };
    },
  },
});
