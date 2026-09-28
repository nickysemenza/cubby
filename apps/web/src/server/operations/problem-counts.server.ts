import type { ProblemsCount } from "@cubby/schemas/problems";

import { readProblemCountsFromDurableObject } from "~/server/database-freshness/client";
import type { AuthenticatedStartOperationContext } from "~/server/start-operation.server";
import { defineWorkflowOperation } from "~/server/workflow-runtime";

type ProblemCountsContext = Pick<
  AuthenticatedStartOperationContext,
  "db" | "upcLookupClient"
>;

export async function resolveProblemCounts(
  readFromDurableObject: () => Promise<ProblemsCount | null>,
  fallback: () => Promise<ProblemsCount>,
): Promise<ProblemsCount> {
  return (await readFromDurableObject()) ?? fallback();
}

export const findProblemCountsWorkflow = defineWorkflowOperation(
  "problems.getCounts",
  (context: ProblemCountsContext) =>
    resolveProblemCounts(readProblemCountsFromDurableObject, async () => {
      const { findProblemCounts } =
        await import("~/server/services/problems.service");
      return findProblemCounts(context.db, context.upcLookupClient);
    }),
);
