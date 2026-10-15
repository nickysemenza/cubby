import type { ProblemsCount } from "@cubby/schemas/problems";

import { readProblemCountsFromDurableObject } from "~/server/db/freshness/client";
import type { AuthenticatedStartOperationContext } from "~/server/operation-runtime/start-operation.server";

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

export const readProblemCounts = (context: ProblemCountsContext) =>
  resolveProblemCounts(readProblemCountsFromDurableObject, async () => {
    const { findProblemCounts } =
      await import("~/server/generic/problems/service/problems.service");
    return findProblemCounts(context.db, context.upcLookupClient);
  });
