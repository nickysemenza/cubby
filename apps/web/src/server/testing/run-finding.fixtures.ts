import { feedbackAuthority, runFindingEntity } from "@cubby/schemas/assessment";
import { eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { assessmentState } from "~/server/db/schema";
import {
  isRunFinding,
  publishRunFinding,
  runFindingColumns,
  runFindingData,
  type RunFindingPublication,
} from "~/server/domains/purchase-import/repo/run-finding";
import {
  transitionAssessmentState,
  transitionAssessmentStates,
} from "~/server/generic/assessment/repo/assessment-state";

const resolution = (column: "createdAt" | "actorUserId") =>
  sql`(SELECT f.${sql.identifier(column)} FROM "Feedback" f WHERE f."assessmentId" = ${assessmentState.id} AND f.authority = ${feedbackAuthority.enum.member} ORDER BY f."createdAt" DESC LIMIT 1)`;

/**
 * Read-only `run_finding` rows under the retired RunFinding column names, so
 * assertions read what members see. Seed through {@link seedRunFinding}.
 */
export const runFinding = new QueryBuilder()
  .select({
    id: runFindingColumns.id,
    runId: runFindingColumns.runId,
    ledgerPartyId: runFindingColumns.ledgerPartyId.as("ledgerPartyId"),
    entityKind: runFindingColumns.entityKind,
    entityId: runFindingColumns.entityId,
    kind: runFindingColumns.kind.as("kind"),
    summary: runFindingColumns.summary.as("summary"),
    proposedFix: runFindingColumns.proposedFix.as("proposedFix"),
    probability: runFindingColumns.probability.as("probability"),
    expiresAt: runFindingColumns.expiresAt.as("expiresAt"),
    status: runFindingColumns.status.as("status"),
    autoApplied: runFindingColumns.autoApplied.as("autoApplied"),
    evidenceFingerprint: assessmentState.fingerprint,
    resolvedAt: sql<Date | null>`${resolution("createdAt")}`.as("resolvedAt"),
    resolvedByUserId: sql<string | null>`${resolution("actorUserId")}`.as(
      "resolvedByUserId",
    ),
    createdAt: runFindingColumns.createdAt,
  })
  .from(assessmentState)
  .where(isRunFinding)
  .as("RunFinding");

type RunFindingSeed = Omit<
  RunFindingPublication,
  "proposedFix" | "runId" | "entityKind"
> & {
  runId?: RunFindingPublication["runId"];
  entityKind: string;
  proposedFix?: unknown;
  status?: "open" | "applied" | "dismissed";
};

/** Publishes a finding, then moves it to the seeded status; returns the read row. */
export async function seedRunFinding(db: Database, seed: RunFindingSeed) {
  const published = await publishRunFinding(db, {
    ...seed,
    runId: seed.runId ?? null,
    entityKind: runFindingEntity.parse(seed.entityKind),
    proposedFix: z
      .json()
      .nullable()
      .parse(seed.proposedFix ?? null),
  });
  if (seed.status && seed.status !== "open" && !seed.autoApplied)
    await transitionAssessmentState(
      db,
      published.id,
      { status: seed.status === "applied" ? "applied" : "rejected" },
      { kind: "synthetic_seed" },
    );
  const [row] = await getDb(db)
    .select()
    .from(runFinding)
    .where(eq(runFinding.id, published.id));
  if (!row) throw new Error("Seeded finding is not readable");
  return row;
}

/** Seeds in order, so `createdAt` follows the list. */
export async function seedRunFindings(
  db: Database,
  seeds: readonly RunFindingSeed[],
) {
  const rows = [];
  for (const seed of seeds) rows.push(await seedRunFinding(db, seed));
  return rows;
}

/** Changes what the current finding row reads; its Assessment keeps the original. */
export async function patchRunFindingData(
  db: Database,
  id: string,
  patch: { proposedFix?: unknown; expiresAt?: Date | null },
) {
  await transitionAssessmentStates(
    db,
    eq(assessmentState.id, id),
    (row) => ({
      data: {
        ...runFindingData.parse(row.data),
        ...("proposedFix" in patch && {
          proposedFix: z.json().parse(patch.proposedFix),
        }),
        ...("expiresAt" in patch && {
          expiresAt: patch.expiresAt?.toISOString() ?? null,
        }),
      },
    }),
    { kind: "synthetic_patch" },
  );
}
