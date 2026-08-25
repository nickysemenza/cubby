import { referentialLivenessViolationSchema } from "@cubby/schemas/entity-integrity";
import { z } from "zod";
import type { StartOperationResult } from "~/server/start-operation.contract";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";

const problemByTypeInputSchema = z.object({
  key: z.literal("referentialLivenessViolations"),
});
const problemByTypeOutputSchema = z.object({
  type: z.literal("referentialLivenessViolations"),
  items: z.array(referentialLivenessViolationSchema),
  total: z.number().int().nonnegative(),
});

/**
 * The sample grain the Problems dashboard uses for a derived detector. Held
 * here so `/entities?tab=integrity` renders the same page of violations it did
 * when this read went through `findProblemByType`; `total` stays the uncapped
 * count the detector reported.
 */
const VIOLATION_SAMPLE_SIZE = 12;

/**
 * The entity inspector's referential-liveness read.
 *
 * It reaches the one detector it needs rather than the Problems service, which
 * would pull the whole five-lane operation graph — every detector, presenter,
 * USDA enrichment, and tracker index — into this request just to answer one
 * question. The import stays dynamic so nothing on the Start module graph pays
 * for the audit's SQL until a tab actually asks for it.
 */
export async function getProblemByType(options: {
  data: z.input<typeof problemByTypeInputSchema>;
  request: StartOperationRequest;
}): Promise<StartOperationResult<z.output<typeof problemByTypeOutputSchema>>> {
  return await runStartOperation({
    operation: "problems.getByType",
    type: "query",
    input: options.data,
    inputSchema: problemByTypeInputSchema,
    outputSchema: problemByTypeOutputSchema,
    request: options.request,
    readPolicy: "strong",
    run: async (context, input) => {
      const { findReferentialLivenessViolations } = await import(
        "~/server/repo/problems/detectors-integrity"
      );
      const violations = await findReferentialLivenessViolations(context.db);
      return {
        type: input.key,
        items: violations.slice(0, VIOLATION_SAMPLE_SIZE),
        total: violations.length,
      };
    },
  });
}
