import { runEntityId, locationId } from "@cubby/schemas/identifiers";
import { z } from "zod";

import { aiRunOwner } from "~/server/ai/policy/call-owner";
import { definePass } from "~/server/kernel/api";
import { WorkSupersededError } from "~/server/kernel/work-errors";
import { withExecutionFence } from "~/server/workflows/runs/execution";
const input = z.object({ locationId, runId: runEntityId.optional() });
/** The model turn is an Ask; this Pass owns its requested inventory-evidence publication. */
export const locationInventoryPass = definePass({
  name: "location.inventory",
  async run(db, cursor, claim) {
    const task = input.parse(cursor);
    const vision = await import("~/server/ai/enrichment/location-vision");
    try {
      await withExecutionFence(
        {
          fence: claim.fence,
          check: async () => {
            if (!(await claim.renew())) throw new WorkSupersededError();
          },
        },
        () =>
          vision.detectInventoryItems(
            db,
            task.locationId,
            aiRunOwner(task.runId ?? null),
            undefined,
            undefined,
            claim.fenced,
          ),
      );
    } catch (error) {
      if (!vision.isLocationHasNoImagesToAnalyzeError(error)) throw error;
    }
    return { cursor, done: true };
  },
});
