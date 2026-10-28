import { vendorOut } from "@cubby/schemas/entities/vendor";
import type { fetchVendorLogoInput } from "@cubby/schemas/vendor";
import { mergeVendorsOut, vendorCoverageOut } from "@cubby/schemas/vendor";

import { vendorContract } from "~/contracts/vendor.contract";
import { getVendorCoverage } from "~/server/domains/vendor/repo/vendor";
import { fetchAndAttachVendorLogo } from "~/server/domains/vendor/service/vendor-logo.service";
import { executeEntityAs } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import {
  publicFieldEnvelopeRows,
  selectedFieldEnvelopeSchema,
} from "~/server/generic/derived/repo/public-read";
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
    .call(
      "enveloped",
      async ({ context }, { fetch }) =>
        (
          await publicFieldEnvelopeRows({
            db: context.db,
            entity: "vendor",
            schema: vendorOut,
            rows: [fetch.output],
          })
        )[0],
    )
    .output(({ enveloped }) => {
      if (!enveloped) throw new Error("Vendor logo read returned no record");
      return enveloped;
    }),
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
  coverage: async (context, input) => {
    const { latestPurchaseDate, ...coverage } = await getVendorCoverage(
      context.db,
      input,
    );
    const [row] = await publicFieldEnvelopeRows({
      db: context.db,
      entity: "vendor",
      schema: selectedFieldEnvelopeSchema(vendorOut, ["latestPurchaseDate"]),
      rows: [{ id: coverage.vendor.id, latestPurchaseDate }],
    });
    return vendorCoverageOut.parse({ ...coverage, fields: row?.fields });
  },
});
