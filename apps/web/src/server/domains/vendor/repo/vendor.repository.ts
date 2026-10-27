import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mergeVendorsInput,
  vendorMergeSummaryOut,
} from "@cubby/schemas/vendor";
import { rawVendorOut } from "@cubby/schemas/vendor-raw-read";
import { z } from "zod";

import {
  asActor,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { resolveLiveShortcode } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  createVendor,
  deleteVendors,
  mergeVendors,
  updateVendor,
  VENDOR_DELETE_EDGE_POLICY,
  VENDOR_MERGE_EDGE_POLICY,
  vendorScaffold,
} from "./vendor";

export const vendorRepository = defineRepository("vendor", {
  lifecycle: {
    delete: VENDOR_DELETE_EDGE_POLICY,
    merge: VENDOR_MERGE_EDGE_POLICY,
  },
  scaffold: vendorScaffold,
  create: asActor(createVendor),
  update: asActor(updateVendor),
  delete: asActor(deleteVendors),
  merge: {
    input: mergeVendorsInput,
    output: z.object({
      vendor: rawVendorOut,
      mergeSummary: vendorMergeSummaryOut,
    }),
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
