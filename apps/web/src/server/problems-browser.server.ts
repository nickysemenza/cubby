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
      const { findProblemByType } = await import(
        "~/server/services/problems.service"
      );
      return await findProblemByType(
        context.db,
        input.key,
        context.upcLookupClient,
        context.usdaClient,
      );
    },
  });
}
