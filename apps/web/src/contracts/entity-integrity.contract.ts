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

export const entityIntegrityContract = defineContract(
  "entityIntegrity",
  {
    catalog: query({
      description:
        "Read the entity integrity catalog and its current table counts. Use it to identify declared integrity checks before asking for a repair.",
      input: z.null(),
      output: integrityCatalogSchema,
      cache: { tags: [["entityIntegrity"]] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);

export const integrityProblemsContract = defineContract(
  "problems",
  {
    getByType: query({
      note: "Referential-liveness diagnostics",
      description:
        "Read unresolved referential-liveness findings of one declared problem type. Use the returned public record references to repair the owning entities.",
      input: z.object({ key: z.literal("referentialLivenessViolations") }),
      output: referentialLivenessResultSchema,
      cache: { tags: [["problems"]] },
    }),
  },
  { exposure: "capability", mcpToolGroup: "maintenance" },
);
