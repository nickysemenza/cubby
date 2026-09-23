import { aiRunUsageInput, aiRunUsageOut } from "@cubby/schemas/ai";
import {
  importRunBrowserListInput,
  importRunListResponse,
  importRunOut,
} from "@cubby/schemas/import-run";
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
  aiUsage: query({
    input: aiRunUsageInput,
    output: aiRunUsageOut,
  }),
});
