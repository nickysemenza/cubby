import type { fetchVendorLogoInput } from "@cubby/schemas/vendor";
import { mergeVendorsOut } from "@cubby/schemas/vendor";

import { vendorContract } from "~/contracts/vendor.contract";
import { getVendorCoverage } from "~/server/domains/vendor/repo/vendor";
import { fetchAndAttachVendorLogo } from "~/server/domains/vendor/service/vendor-logo.service";
import { executeEntityAs } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { implementOperationDomain } from "~/server/operation-runtime/operation-domain.server";
import { bindWorkflow, workflow } from "~/server/workflows/runtime";

/** The logo writer registers its change inside the attachment transaction. */
const fetchVendorLogoWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof fetchVendorLogoInput._output>(
    "vendor.fetchLogo",
  )
    .commit("fetch", async ({ context }, { input }) =>
      fetchAndAttachVendorLogo(context.db, input.id, context.actorContext),
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
