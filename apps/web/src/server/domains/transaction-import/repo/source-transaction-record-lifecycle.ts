import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import { inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sourceOccurrence, sourceTransactionRecord } from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { createAppError } from "~/server/errors/app-error";

/** Retained replacement decisions and accepted owners protect their observation evidence. */
export async function assertSourceTransactionRecordDeletionAllowed(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const selected = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await unwrapDb(db).execute<{ protected: boolean }>(sql`
    -- includes-deleted: retained source evidence protects its accepted and replacement history.
    SELECT EXISTS (
      SELECT 1 FROM "SourceOccurrence" owner
      WHERE ${notDeleted("owner")} AND (
        owner."replacementObservationId" IN (${selected})
        -- includes-deleted: an accepted reservation protects every retained observation.
        OR (owner."acceptedTransactionId" IS NOT NULL
          AND EXISTS(SELECT 1 FROM "FinancialTransaction" accepted WHERE accepted.id=owner."acceptedTransactionId" AND ${notDeleted("accepted")})
          -- includes-deleted: an accepted reservation protects the original retained observation.
          AND EXISTS (SELECT 1 FROM "SourceTransactionRecord" observation
          WHERE observation."occurrenceId" = owner.id AND observation.id IN (${selected}))))
      UNION ALL
      SELECT 1 FROM "SourceObservationAnnotation" annotation
      JOIN "SourceTransactionRecord" predecessor ON predecessor.id = annotation."observationId"
      WHERE annotation."supersededByObservationId" IN (${selected})
        AND predecessor.id NOT IN (${selected}) AND ${notDeleted("predecessor")}
      UNION ALL
      -- Historical bindings remain evidence blockers; they never choose a current owner.
      SELECT 1 FROM "FinancialEvidenceAlias" evidence
      JOIN "FinancialEvidenceAlias" binding ON binding.source=evidence.source AND binding.value=evidence.value AND ${notDeleted("binding")}
      JOIN "FinancialTransaction" target ON target.id=binding."historicalTransactionId" AND ${notDeleted("target")}
      WHERE evidence."observationId" IN (${selected}) AND binding."historicalTransactionId" IS NOT NULL
    ) AS protected`);
  if (rows[0]?.protected)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Retained replacement or accepted financial evidence still requires this observation.",
    );
}

/** Source command reservations and occurrences precede the generic observation row lock. */
export async function lockSourceObservationRemoval(
  tx: DrizzleTransaction,
  ids: readonly SourceTransactionRecordId[],
): Promise<void> {
  if (!ids.length) return;
  const db = unwrapDb(tx);
  const observations = await db
    .select({
      source: sourceTransactionRecord.source,
      occurrenceId: sourceTransactionRecord.occurrenceId,
    })
    .from(sourceTransactionRecord)
    .where(inArray(sourceTransactionRecord.id, [...ids]));
  await lockFinancialEvidenceKeys(
    tx,
    "source",
    observations.map((row) => row.source),
  );
  const ownerIds = observations.flatMap((row) =>
    row.occurrenceId ? [row.occurrenceId] : [],
  );
  if (!ownerIds.length) return;
  const before = await db
    .select()
    .from(sourceOccurrence)
    .where(inArray(sourceOccurrence.id, ownerIds));
  await lockFinancialEvidenceKeys(
    tx,
    "reviewed-booking",
    before.flatMap((owner) =>
      owner.acceptedTransactionId
        ? [`transaction:${owner.acceptedTransactionId}`]
        : [],
    ),
  );
  const locked = await db
    .select()
    .from(sourceOccurrence)
    .where(inArray(sourceOccurrence.id, ownerIds))
    .orderBy(sourceOccurrence.id)
    .for("update");
  if (
    locked.some(
      (owner) =>
        before.find((previous) => previous.id === owner.id)
          ?.acceptedTransactionId !== owner.acceptedTransactionId,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Source ownership changed before removal; refresh the retained evidence and retry.",
    );
}
