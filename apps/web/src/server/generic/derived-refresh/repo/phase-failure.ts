import { DERIVED_REFRESH_MAX_FAILURES } from "@cubby/schemas/derived-refresh";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { derivedRefreshFailure } from "~/server/db/schema";

export type PhaseFailureInput = Pick<
  typeof derivedRefreshFailure.$inferInsert,
  "entityKind" | "entityId" | "phase" | "fingerprint"
>;

export async function readPhaseFailure(db: Database, input: PhaseFailureInput) {
  const [row] = await getDb(db)
    .select()
    .from(derivedRefreshFailure)
    .where(
      and(
        eq(derivedRefreshFailure.entityKind, input.entityKind),
        eq(derivedRefreshFailure.entityId, input.entityId),
        eq(derivedRefreshFailure.phase, input.phase),
        eq(derivedRefreshFailure.fingerprint, input.fingerprint),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The caller acknowledges ownership in the same transaction or rolls this back. */
export async function recordPhaseFailure(
  db: Database,
  input: PhaseFailureInput,
  message: string,
) {
  const [row] = await getDb(db)
    .insert(derivedRefreshFailure)
    .values({ ...input, attempts: 1, lastError: message })
    .onConflictDoUpdate({
      target: [
        derivedRefreshFailure.entityKind,
        derivedRefreshFailure.entityId,
        derivedRefreshFailure.phase,
        derivedRefreshFailure.fingerprint,
      ],
      set: {
        attempts: sql`LEAST(${DERIVED_REFRESH_MAX_FAILURES}, ${derivedRefreshFailure.attempts}+1)`,
        lastError: message,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  if (!row) throw new Error("Derived phase failure was not recorded");
  return row;
}

export function phaseAfterFailure(phase: string) {
  switch (phase) {
    case "projection":
      return "assessment";
    case "assessment":
      return "recipe";
    case "recipe":
      return "dependencies";
    case "dependencies":
      return "completed";
    default:
      return "dependencies";
  }
}
