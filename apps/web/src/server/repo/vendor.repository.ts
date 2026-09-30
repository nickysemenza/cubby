import { parseEntityId } from "@cubby/schemas/identifiers";
import { mergeVendorsInput, mergeVendorsOut } from "@cubby/schemas/vendor";

import {
  asActor,
  defineRepository,
  listOn,
  onDb,
} from "~/server/repo/repository";
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
  vendorListRead,
  vendorListSummary,
} from "./vendor";

export const vendorRepository = defineRepository("vendor", {
  lifecycle: {
    delete: VENDOR_DELETE_EDGE_POLICY,
    merge: VENDOR_MERGE_EDGE_POLICY,
  },
  get: onDb(getVendorByShortcode),
  list: listOn(vendorList),
  listRead: (ctx, filters, sorts, pagination, projection) =>
    vendorListRead(ctx.db, filters, sorts, pagination, "page", projection),
  listSummary: (ctx, filters) => vendorListSummary(ctx.db, filters),
  create: asActor(createVendor),
  update: asActor(updateVendor),
  delete: asActor(deleteVendors),
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
