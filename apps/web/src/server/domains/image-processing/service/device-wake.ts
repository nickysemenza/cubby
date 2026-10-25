import { z } from "zod";

import {
  parkedDeviceWork,
  ringImageProcessingCompanions,
} from "~/server/domains/image-processing/repo/image-processing-ring";
import { defineJobHandler } from "~/server/generic/jobs/service/jobs";

/**
 * One wake page: ring companions if parked device work is claimable now,
 * then sleep until the next parked availability or lease expiry, or finish
 * when none is scheduled. Arms (`armDeviceWake`) wake it again.
 */
export const deviceWakeHandler = defineJobHandler(z.object({}), async (db) => {
  const { due, next } = await parkedDeviceWork(db, new Date());
  if (due) await ringImageProcessingCompanions();
  return {
    page: next ? { done: false, availableAt: next } : { done: true },
  };
});
