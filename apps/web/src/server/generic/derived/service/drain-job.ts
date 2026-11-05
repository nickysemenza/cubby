import { z } from "zod";

import { defineJobHandler } from "~/server/generic/jobs/service/jobs";
import type { JobHandler } from "~/server/generic/jobs/types";

/** Retained predecessor Jobs settle without consuming or deleting their tickets. */
export const derivedReconcileHandler: JobHandler = defineJobHandler(
  z.object({}).passthrough(),
  async () => ({ page: { done: true, result: { outcome: "retired" } } }),
);
