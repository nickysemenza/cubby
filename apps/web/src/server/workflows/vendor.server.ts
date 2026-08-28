import {
  type fetchVendorLogoInput,
  type mergeVendorsInput,
  mergeVendorsOut,
} from "@cubby/schemas/vendor";

import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { vendorOptions } from "~/server/repo/vendor";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";
import { fetchAndAttachVendorLogo } from "~/server/services/vendor-logo.service";
export const vendorOptionsWorkflow = (ctx: EntityKernelContext) =>
  vendorOptions(ctx.readDb);

export async function mergeVendorsWorkflow(
  ctx: EntityKernelContext,
  input: typeof mergeVendorsInput._output,
) {
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
}

export async function fetchVendorLogoWorkflow(
  ctx: EntityKernelContext,
  input: typeof fetchVendorLogoInput._output,
) {
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
}
