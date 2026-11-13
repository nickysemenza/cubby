import type { ActorContext } from "@cubby/schemas/context";
import type {
  FinancialAccountId,
  SourceTransactionRecordId,
} from "@cubby/schemas/identifiers";
import type {
  SourceTransactionRecordDisposition,
  SourceTransactionRecordDispositionReason,
} from "@cubby/schemas/source-transaction-record-fields";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { isEqual } from "es-toolkit";

import type { DrizzleTransaction } from "~/server/db";
import { databaseForTransaction, unwrapDb } from "~/server/db/helpers";
import { uuidArrayParam } from "~/server/db/helpers/query";
import {
  sourceOccurrence,
  sourceTransactionRecord,
  financialTransaction,
  financialAccount,
} from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  decide,
  householdWrite,
  reconcileNow,
  type DecisionInput,
} from "~/server/kernel/api";

import {
  sourceObservationColumns,
  sourceObservationFacts,
  sourceObservationsForPage,
} from "./source-observation-state";

export type SourceJudgmentPatch = {
  accountId?: FinancialAccountId | null;
  disposition?: SourceTransactionRecordDisposition;
  dispositionReason?: SourceTransactionRecordDispositionReason | null;
  dispositionNote?: string | null;
  supersededByRowId?: SourceTransactionRecordId | null;
  notes?: string | null;
};

/** Explicit replacement decisions need cycle protection, never owner/state inheritance. */
async function replacementDecisionClosure(
  tx: DrizzleTransaction,
  ids: readonly SourceTransactionRecordId[],
) {
  if (!ids.length) return [];
  const rows = await unwrapDb(tx).execute<{
    id: SourceTransactionRecordId;
    occurrenceId: string | null;
  }>(
    sql`
    WITH RECURSIVE decisions AS (
      SELECT r.id, r."occurrenceId", r."supersededByRowId", ARRAY[r.id] AS visited FROM ${sourceObservationFacts} r
      WHERE r.id = ANY(${uuidArrayParam(ids)})
      UNION ALL
      SELECT r.id, r."occurrenceId", r."supersededByRowId", decisions.visited || r.id
      FROM decisions JOIN ${sourceObservationFacts} r ON r.id = decisions."supersededByRowId"
      WHERE NOT r.id = ANY(decisions.visited)
    ) SELECT DISTINCT id, "occurrenceId" FROM decisions`,
    "objects",
  );
  return rows;
}

/** Member annotations and occurrence judgments are independent decision slots. */
export async function updateSourceObservationJudgments(
  tx: DrizzleTransaction,
  ids: readonly SourceTransactionRecordId[],
  patch: SourceJudgmentPatch,
  actor: ActorContext,
): Promise<{ affected: number }> {
  if (!ids.length || Object.values(patch).every((value) => value === undefined))
    return { affected: 0 };
  return householdWrite(databaseForTransaction(tx), async (database) => {
    const q = unwrapDb(database);
    const selected = await q
      .select()
      .from(sourceTransactionRecord)
      .where(
        and(
          inArray(sourceTransactionRecord.id, [...ids]),
          isNull(sourceTransactionRecord.deletedAt),
        ),
      );
    if (selected.length !== new Set(ids).size)
      throw createAppError(
        "REFERENCED_RECORD_MISSING",
        "A source observation is no longer live.",
      );
    const owners = await q
      .select()
      .from(sourceOccurrence)
      .where(
        inArray(sourceOccurrence.id, [
          ...new Set(selected.map((row) => row.occurrenceId)),
        ]),
      );
    const [successor] = patch.supersededByRowId
      ? await q
          .select()
          .from(sourceTransactionRecord)
          .where(
            and(
              eq(sourceTransactionRecord.id, patch.supersededByRowId),
              isNull(sourceTransactionRecord.deletedAt),
            ),
          )
      : [];
    if (
      patch.supersededByRowId &&
      (!successor || selected.some((row) => row.source !== successor.source))
    )
      throw createAppError(
        "CONSTRAINT_VIOLATION",
        "A replacement observation must be live and belong to the same source.",
      );
    if (successor) {
      const chain = await replacementDecisionClosure(tx, [successor.id]);
      if (selected.some((row) => chain.some((member) => member.id === row.id)))
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Source replacement cannot link to itself or form a cycle.",
        );
    }
    if (patch.accountId !== undefined) {
      if (patch.accountId) {
        const [account] = await q
          .select({ id: financialAccount.id })
          .from(financialAccount)
          .where(
            and(
              eq(financialAccount.id, patch.accountId),
              isNull(financialAccount.deletedAt),
            ),
          );
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
        ? await q
            .select()
            .from(financialTransaction)
            .where(inArray(financialTransaction.id, acceptedIds))
        : [];
      if (accepted.some((row) => row.accountId !== patch.accountId))
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          "Detach accepted source evidence before changing its resolved account.",
        );
    }
    const before = await q
      .select(sourceObservationColumns)
      .from(
        sql`${sourceObservationsForPage([...ids])} "SourceTransactionRecord"`,
      );
    const decisions: DecisionInput[] = [];
    for (const owner of owners) {
      const values = {
        accountId: patch.accountId,
        disposition: patch.disposition,
        dispositionReason: patch.dispositionReason,
        dispositionNote: patch.dispositionNote,
        ...(patch.supersededByRowId !== undefined
          ? successor?.occurrenceId === owner.id
            ? {
                currentObservationId: successor.id,
                reviewState:
                  owner.reviewState === "revision_order_unknown"
                    ? "ready"
                    : undefined,
                supersededByRowId: null,
              }
            : { supersededByRowId: successor?.id ?? null }
          : {}),
      };
      for (const [field, value] of Object.entries(values))
        if (value !== undefined)
          decisions.push({
            channel: "assignment",
            kind: "set",
            subject: `bank:${owner.id}`,
            field,
            value,
            scopes: [{ kind: "bankEvent", key: owner.id }],
          });
    }
    for (const row of selected) {
      if (patch.notes !== undefined)
        decisions.push({
          channel: "assignment",
          kind: "set",
          subject: `sourceObservation:${row.id}`,
          field: "notes",
          value: patch.notes,
        });
      if (successor?.occurrenceId === row.occurrenceId)
        decisions.push({
          channel: "assignment",
          kind: "set",
          subject: `sourceObservation:${row.id}`,
          field: "supersededByObservationId",
          value: successor.id,
        });
    }
    await decide(database, actor, decisions);
    const resolutions = owners
      .map((owner) => {
        const same = successor?.occurrenceId === owner.id;
        const values = {
          accountId: patch.accountId,
          disposition: patch.disposition,
          dispositionReason: patch.dispositionReason,
          dispositionNote: patch.dispositionNote,
          ...(patch.supersededByRowId !== undefined
            ? same
              ? {
                  currentObservationId: successor.id,
                  reviewState:
                    owner.reviewState === "revision_order_unknown"
                      ? "ready"
                      : undefined,
                }
              : {
                  supersededByOccurrenceId: successor?.occurrenceId ?? null,
                  replacementObservationId: successor?.id ?? null,
                }
            : {}),
        };
        const set = Object.fromEntries(
          Object.entries(values).filter(([, value]) => value !== undefined),
        );
        return { owner, set };
      })
      .filter(({ owner, set }) => {
        const before = new Map(Object.entries(owner));
        return Object.entries(set).some(
          ([field, value]) => before.get(field) !== value,
        );
      });
    for (const { owner, set } of resolutions)
      await q
        .update(sourceOccurrence)
        .set({ ...set, version: owner.version + 1 })
        .where(eq(sourceOccurrence.id, owner.id));
    if (resolutions.length) {
      const { emitWrites } = await import("~/server/kernel/api");
      await emitWrites(database, {
        table: sourceOccurrence,
        ids: resolutions.map((row) => row.owner.id),
        columns: [
          ...new Set(resolutions.flatMap((row) => Object.keys(row.set))),
        ],
      });
    }
    await reconcileNow(
      database,
      owners.map((owner) => ({ kind: "bankEvent", key: owner.id })),
    );
    const after = await q
      .select(sourceObservationColumns)
      .from(
        sql`${sourceObservationsForPage([...ids])} "SourceTransactionRecord"`,
      );
    return {
      affected: after.filter((row) => {
        const previous = before.find((value) => value.id === row.id);
        return !isEqual(previous, row);
      }).length,
    };
  });
}
