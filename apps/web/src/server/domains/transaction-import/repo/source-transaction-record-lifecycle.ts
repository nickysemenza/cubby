import type { ActorContext } from "@cubby/schemas/context";
import type { SourceTransactionRecordId } from "@cubby/schemas/identifiers";
import { and, eq, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { isTransaction, unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { sourceOccurrence, sourceTransactionRecord } from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { tombstoneEntityIdentities } from "~/server/entity-kernel/repo/entity-identity-writer";
import { createAppError } from "~/server/errors/app-error";

import { auditEvidenceRows } from "./intake-audit";

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
  const rows = await unwrapDb(db).execute<{ protected: boolean }>(
    sql`
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
    ) AS protected`,
    "objects",
  );
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
  const ownerIds = observations.map((row) => row.occurrenceId);
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

/** An unproven reservation survives deletion without keeping a current account assignment live. */
export async function retireDeletedUnprovenOwners(
  db: Database,
  ids: readonly SourceTransactionRecordId[],
  actor: ActorContext,
): Promise<void> {
  if (!ids.length) return;
  const query = unwrapDb(db);
  if (!isTransaction(query))
    throw new Error(
      "Unproven owner retirement must share the bank-record deletion transaction.",
    );
  const selected = await query
    .select({ id: sourceTransactionRecord.occurrenceId })
    .from(sourceTransactionRecord)
    .where(inArray(sourceTransactionRecord.id, [...ids]));
  if (!selected.length) return;
  const candidates = await query
    .select()
    .from(sourceOccurrence)
    .where(
      and(
        inArray(
          sourceOccurrence.id,
          selected.map((row) => row.id),
        ),
        eq(sourceOccurrence.identityKind, "unproven"),
        notDeleted(sourceOccurrence),
      ),
    )
    .orderBy(sourceOccurrence.id)
    .for("update");
  if (!candidates.length) return;
  const live = await query
    .select({ id: sourceTransactionRecord.occurrenceId })
    .from(sourceTransactionRecord)
    .where(
      and(
        inArray(
          sourceTransactionRecord.occurrenceId,
          candidates.map((owner) => owner.id),
        ),
        notDeleted(sourceTransactionRecord),
      ),
    );
  const liveIds = new Set(live.map((row) => row.id));
  const owners = candidates.filter((owner) => !liveIds.has(owner.id));
  if (!owners.length) return;
  const at = new Date();
  const retired = await query
    .update(sourceOccurrence)
    .set({
      deletedAt: at,
      updatedAt: at,
      version: sql`${sourceOccurrence.version}+1`,
    })
    .where(
      inArray(
        sourceOccurrence.id,
        owners.map((owner) => owner.id),
      ),
    )
    .returning();
  await tombstoneEntityIdentities(
    query,
    owners.map((owner) => owner.id),
    at,
  );
  await auditEvidenceRows(db, actor, "sourceOccurrence", owners, retired);
}
