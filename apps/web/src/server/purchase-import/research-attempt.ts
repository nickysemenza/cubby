import type { RunId } from "@cubby/schemas/identifiers";
import type { ResearchWorkResolution } from "@cubby/schemas/research-tools";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { runOperation } from "~/server/db/schema";

/** Completed operation receipts count attempts once, including after replay. */
export async function researchAttemptDisposition(
  tx: DrizzleTransaction,
  input: {
    runId: RunId;
    workRef: string;
    outcome: ResearchWorkResolution["status"];
    correctable: boolean;
    progress: boolean;
    refusals: { path: string; reason: string }[];
  },
) {
  if (!input.correctable)
    return { retry: false, outcome: input.outcome, correctionAttempt: false };
  if (input.progress)
    return { retry: true, outcome: input.outcome, correctionAttempt: false };
  const [previous] = await tx
    .select({ count: sql<number>`count(*)::integer` })
    .from(runOperation)
    .where(
      and(
        eq(runOperation.runId, input.runId),
        eq(runOperation.state, "completed"),
        inArray(runOperation.kind, [
          "research_resolve_product",
          "research_resolve_import",
        ]),
        sql`${runOperation.result}->'attempt'->>'workRef' = ${input.workRef}`,
        sql`${runOperation.result}->>'correctionAttempt' = 'true'`,
      ),
    );
  const retry = (previous?.count ?? 0) + 1 < 3;
  input.refusals.push({
    path: "attempt",
    reason: retry
      ? "Work remains active. Correct the refused claims or provide additional retained support; report explicit gaps or ambiguity when they cannot be resolved."
      : "Research resolution attempt limit (3) reached. Unsupported claims remain gaps for review; no full verification is claimed.",
  });
  return {
    retry,
    correctionAttempt: true,
    outcome: retry ? input.outcome : ("researched_with_gaps" as const),
  };
}
