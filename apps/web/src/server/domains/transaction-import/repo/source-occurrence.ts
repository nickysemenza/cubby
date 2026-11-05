import type { ActorContext } from "@cubby/schemas/context";
import type {
  FinancialAccountId,
  SourceTransactionRecordId,
} from "@cubby/schemas/identifiers";
import type {
  SourceTransactionRecordDisposition,
  SourceTransactionRecordDispositionReason,
} from "@cubby/schemas/source-transaction-record-fields";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { notDeleted, unwrapDb } from "~/server/db/helpers";
import {
  sourceOccurrence,
  sourceObservationAnnotation,
  sourceTransactionRecord,
  financialTransaction,
  financialAccount,
} from "~/server/db/schema";
import { lockFinancialEvidenceKeys } from "~/server/domains/financial-transaction/repo/financial-evidence";
import { createAppError } from "~/server/errors/app-error";
import { recordChange } from "~/server/generic/changes/repo/change";

import { auditEvidenceRows, evidenceChanges } from "./intake-audit";
import {
  sourceObservationColumns,
  sourceObservationFrom,
  sourceObservations,
} from "./source-observation-state";

export type SourceJudgmentPatch = {
  accountId?: FinancialAccountId | null;
  disposition?: SourceTransactionRecordDisposition;
  dispositionReason?: SourceTransactionRecordDispositionReason | null;
  dispositionNote?: string | null;
  supersededByRowId?: SourceTransactionRecordId | null;
  notes?: string | null;
};

type JudgmentValues = SourceJudgmentPatch &
  Partial<
    Pick<
      typeof sourceOccurrence.$inferInsert,
      | "currentObservationId"
      | "reviewState"
      | "supersededByOccurrenceId"
      | "replacementObservationId"
    >
  > & { supersededByObservationId?: SourceTransactionRecordId | null };
const hasChangedValues = (
  values: JudgmentValues,
  before:
    | typeof sourceOccurrence.$inferSelect
    | typeof sourceObservationAnnotation.$inferSelect
    | undefined,
): boolean => {
  const stored = new Map(Object.entries(before ?? {}));
  return Object.entries(values).some(
    ([key, value]) => value !== undefined && value !== stored.get(key),
  );
};

/** Explicit replacement decisions need cycle protection, never owner/state inheritance. */
async function replacementDecisionClosure(
  tx: DrizzleTransaction,
  ids: readonly SourceTransactionRecordId[],
) {
  if (!ids.length) return [];
  const { rows } = await unwrapDb(tx).execute<{
    id: SourceTransactionRecordId;
    occurrenceId: string | null;
  }>(sql`
    WITH RECURSIVE decisions AS (
      SELECT r.id, r."occurrenceId", r."supersededByRowId", ARRAY[r.id] AS visited FROM ${sourceObservations} r
      WHERE r.id IN (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
      UNION ALL
      SELECT r.id, r."occurrenceId", r."supersededByRowId", decisions.visited || r.id
      FROM decisions JOIN ${sourceObservations} r ON r.id = decisions."supersededByRowId"
      WHERE NOT r.id = ANY(decisions.visited)
    ) SELECT DISTINCT id, "occurrenceId" FROM decisions`);
  return rows;
}

/** One current judgment owner. Unattested observations retain their own decisions; notes stay local. */
export async function updateSourceObservationJudgments(
  tx: DrizzleTransaction,
  ids: readonly SourceTransactionRecordId[],
  patch: SourceJudgmentPatch,
  actor: ActorContext,
): Promise<{ affected: number }> {
  if (!ids.length || Object.values(patch).every((value) => value === undefined))
    return { affected: 0 };
  const db = unwrapDb(tx);
  const sourceKeys = await db
    .select({ source: sourceTransactionRecord.source })
    .from(sourceTransactionRecord)
    .where(inArray(sourceTransactionRecord.id, [...ids]));
  await lockFinancialEvidenceKeys(
    tx,
    "source",
    sourceKeys.map((row) => row.source),
  );
  const selected = await db
    .select()
    .from(sourceTransactionRecord)
    .where(
      and(
        inArray(sourceTransactionRecord.id, [...ids]),
        notDeleted(sourceTransactionRecord),
      ),
    );
  if (selected.length !== new Set(ids).size)
    throw createAppError(
      "REFERENCED_RECORD_MISSING",
      "A source observation is no longer live.",
    );
  const closure = await replacementDecisionClosure(tx, [
    ...ids,
    ...(patch.supersededByRowId ? [patch.supersededByRowId] : []),
  ]);
  const occurrenceIds = [
    ...new Set(
      closure.flatMap((row) => (row.occurrenceId ? [row.occurrenceId] : [])),
    ),
  ].sort();
  const ownersBeforeLock = occurrenceIds.length
    ? await db
        .select()
        .from(sourceOccurrence)
        .where(
          sql`${sourceOccurrence.id} IN (${sql.join(
            occurrenceIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        )
    : [];
  await lockFinancialEvidenceKeys(
    tx,
    "reviewed-booking",
    ownersBeforeLock.flatMap((owner) =>
      owner.acceptedTransactionId
        ? [`transaction:${owner.acceptedTransactionId}`]
        : [],
    ),
  );
  const owners = occurrenceIds.length
    ? await db
        .select()
        .from(sourceOccurrence)
        .where(
          sql`${sourceOccurrence.id} IN (${sql.join(
            occurrenceIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`,
        )
        .orderBy(sourceOccurrence.id)
        .for("update")
    : [];
  if (
    owners.some(
      (owner) =>
        ownersBeforeLock.find((before) => before.id === owner.id)
          ?.acceptedTransactionId !== owner.acceptedTransactionId,
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Source ownership changed before its judgment lock; retry with current evidence.",
    );
  const freshClosure = await replacementDecisionClosure(tx, [
    ...ids,
    ...(patch.supersededByRowId ? [patch.supersededByRowId] : []),
  ]);
  if (
    freshClosure.some(
      (row) =>
        !closure.some(
          (before) =>
            before.id === row.id && before.occurrenceId === row.occurrenceId,
        ),
    )
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Replacement evidence expanded while locking; retry with current evidence.",
    );
  await db
    .select({ id: sourceTransactionRecord.id })
    .from(sourceTransactionRecord)
    .where(
      inArray(
        sourceTransactionRecord.id,
        closure.map((row) => row.id),
      ),
    )
    .orderBy(sourceTransactionRecord.id)
    .for("update");
  const successor = patch.supersededByRowId
    ? (
        await db
          .select()
          .from(sourceTransactionRecord)
          .where(
            and(
              eq(sourceTransactionRecord.id, patch.supersededByRowId),
              notDeleted(sourceTransactionRecord),
            ),
          )
      )[0]
    : undefined;
  if (
    patch.supersededByRowId &&
    (!successor || selected.some((row) => row.source !== successor.source))
  )
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A replacement observation must be live and belong to the same source.",
    );
  if (patch.supersededByRowId) {
    const chain = await replacementDecisionClosure(tx, [
      patch.supersededByRowId,
    ]);
    if (selected.some((row) => chain.some((member) => member.id === row.id)))
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Source replacement cannot link to itself or form a cycle.",
      );
  }
  if (patch.accountId !== undefined) {
    if (patch.accountId !== null) {
      const [account] = await db
        .select({ id: financialAccount.id })
        .from(financialAccount)
        .where(
          and(
            eq(financialAccount.id, patch.accountId),
            notDeleted(financialAccount),
          ),
        )
        .for("key share");
      if (!account)
        throw createAppError(
          "REFERENCED_RECORD_MISSING",
          "The source account is no longer live.",
        );
    }
    const acceptedIds = owners.flatMap((owner) =>
      owner.acceptedTransactionId ? [owner.acceptedTransactionId] : [],
    );
    const accepted = acceptedIds.length
      ? await db
          .select()
          .from(financialTransaction)
          .where(inArray(financialTransaction.id, acceptedIds))
      : [];
    if (
      owners.some(
        (owner) =>
          owner.acceptedTransactionId !== null &&
          accepted.find((row) => row.id === owner.acceptedTransactionId)
            ?.accountId !== patch.accountId,
      )
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "Detach accepted source evidence before changing its resolved account to a different account.",
      );
  }
  const before = await db
    .select(sourceObservationColumns)
    .from(sourceObservationFrom)
    .where(inArray(sourceTransactionRecord.id, [...ids]));
  const { notes: _notes, supersededByRowId: _successor, ...financial } = patch;
  const changedOwners: typeof owners = [];
  for (const owner of owners.filter((owner) =>
    selected.some((row) => row.occurrenceId === owner.id),
  )) {
    const sameOccurrence = successor?.occurrenceId === owner.id;
    const values = {
      ...financial,
      ...(patch.supersededByRowId === undefined
        ? {}
        : sameOccurrence
          ? {
              currentObservationId: successor.id,
              ...(owner.reviewState === "revision_order_unknown"
                ? { reviewState: "ready" as const }
                : {}),
            }
          : {
              supersededByOccurrenceId: successor?.occurrenceId ?? null,
              replacementObservationId: successor?.id ?? null,
            }),
    };
    if (hasChangedValues(values, owner)) {
      const updated = await db
        .update(sourceOccurrence)
        .set({ ...values, version: sql`${sourceOccurrence.version} + 1` })
        .where(eq(sourceOccurrence.id, owner.id))
        .returning();
      changedOwners.push(...updated);
    }
  }
  for (const observation of selected) {
    const [annotation] = await db
      .select()
      .from(sourceObservationAnnotation)
      .where(eq(sourceObservationAnnotation.observationId, observation.id))
      .for("update");
    const values = {
      ...(observation.occurrenceId === null
        ? { ...financial, supersededByObservationId: patch.supersededByRowId }
        : {}),
      // Retain the exact reviewed version selection as history without copying financial judgments.
      ...(observation.occurrenceId !== null &&
      successor?.occurrenceId === observation.occurrenceId
        ? { supersededByObservationId: successor.id }
        : {}),
      notes: patch.notes,
    };
    if (!hasChangedValues(values, annotation)) continue;
    if (annotation)
      await db
        .update(sourceObservationAnnotation)
        .set(values)
        .where(eq(sourceObservationAnnotation.observationId, observation.id));
    else
      await db
        .insert(sourceObservationAnnotation)
        .values({ observationId: observation.id, ...values });
  }
  await auditEvidenceRows(
    tx,
    actor,
    "sourceOccurrence",
    owners.filter((owner) =>
      changedOwners.some((changed) => changed.id === owner.id),
    ),
    changedOwners,
  );
  const after = await db
    .select(sourceObservationColumns)
    .from(sourceObservationFrom)
    .where(inArray(sourceTransactionRecord.id, [...ids]));
  const changed = after.filter((row) =>
    evidenceChanges(
      before.find((previous) => previous.id === row.id),
      row,
    ),
  );
  await auditEvidenceRows(
    tx,
    actor,
    "sourceTransactionRecord",
    before,
    changed,
  );
  if (changed.length || changedOwners.length)
    await recordChange(tx, { kind: "source", categories: [] });
  return { affected: changed.length };
}
