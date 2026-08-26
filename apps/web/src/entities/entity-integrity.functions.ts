import {
  integrityCatalogSchema,
  referentialLivenessViolationSchema,
} from "@cubby/schemas/entity-integrity";
import { z } from "zod";
import {
  defineOperationDomain,
  query,
} from "~/integrations/tanstack-query/operation-catalog";

export const REFERENTIAL_LIVENESS_INPUT = {
  key: "referentialLivenessViolations",
} as const;
const referentialLivenessResultSchema = z.object({
  type: z.literal("referentialLivenessViolations"),
  items: z.array(referentialLivenessViolationSchema),
  total: z.number().int().nonnegative(),
});

export const entityIntegrity = defineOperationDomain("entityIntegrity", {
  catalog: query({
    input: z.null(),
    output: integrityCatalogSchema,
    tags: [["entityIntegrity"]],
  }),
});

export const integrityProblems = defineOperationDomain("problems", {
  getByType: query({
    input: z.object({ key: z.literal("referentialLivenessViolations") }),
    output: referentialLivenessResultSchema,
    tags: [["problems"]],
  }),
});
