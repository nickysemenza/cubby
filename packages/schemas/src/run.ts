import { z } from "zod";

import { runPurpose } from "./run-fields";

import { runShortcode } from "./identifiers";

export {
  runFilterFields,
  runFilters,
  runOut,
  type RunFilters,
  type RunOut,
} from "./generated/run.gen";

export const runSummary = z.object({
  publicId: runShortcode,
  purpose: runPurpose,
  vendorAccountLabel: z.string().nullable(),
  vendorName: z.string().nullable(),
  trigger: z.string(),
  status: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  ordersSeen: z.number().int(),
  imported: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  failureCode: z.string().nullable(),
  estimatedCost: z.number().nullable(),
});
export type RunSummary = z.infer<typeof runSummary>;

export const runHistoryOut = z.object({ runs: z.array(runSummary) });
