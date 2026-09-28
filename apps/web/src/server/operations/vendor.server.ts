import {
  type fetchVendorLogoInput,
  type mergeVendorsInput,
  mergeVendorsOut,
} from "@cubby/schemas/vendor";

import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { fetchAndAttachVendorLogo } from "~/server/services/vendor-logo.service";
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

export const mergeVendorsWorkflow = bindWorkflow(
  workflow<EntityKernelContext, typeof mergeVendorsInput._output>(
    "vendor.merge",
  )
    .commit("merge", async ({ context }, { input }) =>
      executeEntity(context, {
        action: "merge",
        entity: "vendor",
        data: input,
      }),
    )
    .output(({ merge }) => {
      if (merge.action !== "merge")
        throw new Error("Entity kernel returned the wrong action");
      return mergeVendorsOut.parse({
        vendor: merge.item,
        mergeSummary: merge.mergeSummary,
      });
    }),
  (ctx: EntityKernelContext, input: typeof mergeVendorsInput._output) => ({
    context: ctx,
    input,
  }),
);
export const fetchVendorLogoWorkflow = bindWorkflow(
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
  (ctx: EntityKernelContext, input: typeof fetchVendorLogoInput._output) => ({
    context: ctx,
    input,
  }),
);
