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
    mcp: { omit: "operator_maintenance" },
    input: z.null(),
    output: integrityCatalogSchema,
    cache: { tags: [["entityIntegrity"]] },
  }),
});

export const integrityProblemsContract = defineContract("problems", {
  getByType: query({
    mcp: {
      omit: "operator_maintenance",
      note: "Referential-liveness diagnostics",
    },
    input: z.object({ key: z.literal("referentialLivenessViolations") }),
    output: referentialLivenessResultSchema,
    cache: { tags: [["problems"]] },
  }),
});
