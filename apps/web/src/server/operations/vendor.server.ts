import type { fetchVendorLogoInput } from "@cubby/schemas/vendor";
import { mergeVendorsOut } from "@cubby/schemas/vendor";

import { vendorContract } from "~/contracts/vendor.contract";
import { executeEntityAs } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { getVendorCoverage } from "~/server/repo/vendor";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { fetchAndAttachVendorLogo } from "~/server/services/vendor-logo.service";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

/** The logo attaches in one committed step; the vendor side effects then run
 * after commit so a cancelled request cannot skip them. */
const fetchVendorLogoWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof fetchVendorLogoInput._output>(
    "vendor.fetchLogo",
  )
    .commit("fetch", async ({ context }, { input }) =>
      fetchAndAttachVendorLogo(context.db, input.id, context.actorContext),
    )
    .effect("effects", async ({ context }, { fetch }) =>
      runMutationSideEffects(context.db, {
        action: "updated",
        entity: { entity: "vendor", id: fetch.entityId },
        source: "vendor.fetchLogo",
      }),
    )
    .output(({ fetch }) => fetch.output),
);

export const vendorHandlers = implementOperationDomain(vendorContract, {
  merge: async (context, input) => {
    const merge = await executeEntityAs(context, "merge", {
      entity: "vendor",
      data: input,
    });
    return mergeVendorsOut.parse({
      vendor: merge.item,
      mergeSummary: merge.mergeSummary,
    });
  },
  fetchLogo: (context, input) => fetchVendorLogoWorkflow(context, input),
  coverage: (context, input) => getVendorCoverage(context.db, input),
});
