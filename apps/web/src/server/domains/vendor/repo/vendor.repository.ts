import { vendorRawOut as rawVendorOut } from "@cubby/schemas/entity-contracts/vendor";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  mergeVendorsInput,
  vendorMergeSummaryOut,
} from "@cubby/schemas/vendor";
import { z } from "zod";

import { vendorSchemaBindings } from "~/entity/generated/entity-schema-bindings.vendor.gen";
import { DECLARED_EDGE_MERGE_POLICIES } from "~/server/db/generated/declared-edges.gen";
import { DECLARED_EDGE_DELETE_POLICIES } from "~/server/db/generated/declared-edges.gen";
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
  vendorScaffold,
} from "./vendor";

export const vendorRepository = defineRepository("vendor", {
  schemas: vendorSchemaBindings,
  lifecycle: {
    delete: DECLARED_EDGE_DELETE_POLICIES.vendor,
    merge: DECLARED_EDGE_MERGE_POLICIES.vendor,
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
