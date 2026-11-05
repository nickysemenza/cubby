import { feedbackAuthority, runFindingEntity } from "@cubby/schemas/assessment";
import { eq, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { z } from "zod";

import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";
import { runFinding as runFindingTable } from "~/server/db/schema";
import {
  publishRunFinding,
  runFindingColumns,
  updateRunFinding,
  type RunFindingPublication,
} from "~/server/domains/purchase-import/repo/run-finding";

const resolution = (key: "createdAt" | "actorUserId") =>
  sql`(SELECT r.value->>${key} FROM jsonb_array_elements(${runFindingTable.resolutions}) r(value) WHERE r.value->>'authority' = ${feedbackAuthority.enum.member} ORDER BY r.value->>'createdAt' DESC LIMIT 1)`;

/**
 * Read-only findings under their presented column names, so assertions read
 * what members see. Seed through {@link seedRunFinding}.
 */
export const runFinding = new QueryBuilder()
  .select({
    id: runFindingColumns.id,
    runId: runFindingColumns.runId,
    ledgerPartyId: runFindingColumns.ledgerPartyId,
    entityKind: runFindingColumns.entityKind,
    entityId: runFindingColumns.entityId,
    kind: runFindingColumns.kind,
    summary: runFindingColumns.summary,
    proposedFix: runFindingColumns.proposedFix,
    probability: runFindingColumns.probability,
    expiresAt: runFindingColumns.expiresAt,
    status: runFindingColumns.status.as("status"),
    autoApplied: runFindingColumns.autoApplied,
    evidenceFingerprint: runFindingTable.evidenceFingerprint,
    resolvedAt: sql<Date | null>`${resolution("createdAt")}::timestamptz`.as(
      "resolvedAt",
    ),
    resolvedByUserId: sql<string | null>`${resolution("actorUserId")}`.as(
      "resolvedByUserId",
    ),
    createdAt: runFindingColumns.createdAt,
  })
  .from(runFindingTable)
  .as("RunFindingRead");

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
    await updateRunFinding(db, published.id, {
      status: seed.status === "applied" ? "applied" : "rejected",
    });
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

/** Changes what the current finding row reads; `judgment` keeps the original. */
export async function patchRunFindingData(
  db: Database,
  id: string,
  patch: { proposedFix?: unknown; expiresAt?: Date | null },
) {
  await updateRunFinding(db, id, {
    ...("proposedFix" in patch && {
      proposedFix: z.json().parse(patch.proposedFix),
    }),
    ...("expiresAt" in patch && { expiresAt: patch.expiresAt ?? null }),
  });
}
