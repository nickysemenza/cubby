import { aiRunUsageInput, aiRunUsageOut } from "@cubby/schemas/ai";
import { importRunOut } from "@cubby/schemas/import-run";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

/**
 * Run reads for the generic detail page. A Run has no create/update contract,
 * so it sits outside the kernel detail roster and reads its own query
 * (`route.detail: { query }`), like image and cookbook.
 */
export const runContract = defineContract("run", {
  detail: query({
    input: z.object({ shortcode: z.string() }),
    output: importRunOut.nullable(),
  }),
  aiUsage: query({
    input: aiRunUsageInput,
    output: aiRunUsageOut,
  }),
});
