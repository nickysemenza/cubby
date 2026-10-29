import type { ProblemsCount } from "@cubby/schemas/problems";

import type { AuthenticatedOperationContext } from "~/server/operation-runtime/operation.server";

type ProblemCountsContext = Pick<
  AuthenticatedOperationContext,
  "db" | "upcLookupClient"
>;

/** Counts are bounded read-only queries; they are read directly, not cached. */
export async function readProblemCounts(
  context: ProblemCountsContext,
): Promise<ProblemsCount> {
  const { findProblemCounts } =
    await import("~/server/generic/problems/service/problems.service");
  return findProblemCounts(context.db, context.upcLookupClient);
}
