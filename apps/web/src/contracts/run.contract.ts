import { aiRunUsageInput, aiRunUsageOut } from "@cubby/schemas/ai";
import { importRunShortcode } from "@cubby/schemas/identifiers";
import {
  importRunBrowserListInput,
  importRunListResponse,
  importRunOut,
} from "@cubby/schemas/import-run";
import {
  importRunPurpose,
  importRunStatus,
} from "@cubby/schemas/import-run-fields";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

/**
 * Run reads for the generic list and detail pages. A Run has no create/update
 * contract, so it sits outside the kernel list and detail rosters and reads
 * its own queries (a list override source, `route.detail: { query }`), like
 * image and cookbook.
 */
export const runContract = defineContract("run", {
  list: query({
    input: importRunBrowserListInput,
    output: importRunListResponse,
  }),
  detail: query({
    input: z.object({ shortcode: z.string() }),
    output: importRunOut.nullable(),
  }),
  workSnapshot: query({
    native: "Show durable live import progress in Apple apps",
    input: z.object({ runId: importRunShortcode }),
    output: z.object({
      runId: importRunShortcode,
      purpose: importRunPurpose,
      status: importRunStatus,
      ordersSeen: z.number().int(),
      imported: z.number().int(),
      updated: z.number().int(),
      skipped: z.number().int(),
      targetsTotal: z.number().int(),
      targetsCompleted: z.number().int(),
      progress: z.array(
        z.object({
          phase: z.string(),
          detail: z.string().nullable(),
          createdAt: z.iso.datetime(),
        }),
      ),
      operations: z.array(
        z.object({
          kind: z.string(),
          state: z.string(),
          startedAt: z.iso.datetime(),
          completedAt: z.iso.datetime().nullable(),
          error: z.string().nullable(),
        }),
      ),
    }),
  }),
  aiUsage: query({
    input: aiRunUsageInput,
    output: aiRunUsageOut,
  }),
});
