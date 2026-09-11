import {
  integrityCatalogSchema,
  referentialLivenessViolationSchema,
} from "@cubby/schemas/entity-integrity";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

const referentialLivenessResultSchema = z.object({
  type: z.literal("referentialLivenessViolations"),
  items: z.array(referentialLivenessViolationSchema),
  total: z.number().int().nonnegative(),
});

export const entityIntegrityContract = defineContract("entityIntegrity", {
  catalog: query({
    input: z.null(),
    output: integrityCatalogSchema,
  }),
});

export const integrityProblemsContract = defineContract("problems", {
  getByType: query({
    input: z.object({ key: z.literal("referentialLivenessViolations") }),
    output: referentialLivenessResultSchema,
  }),
});
