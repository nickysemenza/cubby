import type { ActorContext } from "@cubby/schemas/context";
import {
  type ClearDataExceptionInput,
  type DataExceptionEntity,
  type DataQuality,
  dataCheckEntity,
  dataException,
  dataExceptionEntity,
  type SetDataExceptionInput,
} from "@cubby/schemas/data-quality";
import { isAuditableEntity } from "@cubby/schemas/entity-manifest";
import { ENTITY_NOT_FOUND_REASON } from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { dataExceptionRecord } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

import { exceptionReasonsFor } from "./exception-reasons";
import { loadDataQualities } from "./hydrate";
import { entryFor, fingerprintSql, gapCondition } from "./sql";

const probeRow = z.object({
  fingerprint: z.string(),
  applies: z.boolean(),
});

const storedException = (row: {
  check: string;
  reason: string;
  note: string;
  fingerprint: string;
}) =>
  dataException.parse({
    check: row.check,
    reason: row.reason,
    note: row.note,
    fingerprint: row.fingerprint,
  });

const mutateException = async (
  db: Database,
  input: SetDataExceptionInput | ClearDataExceptionInput,
  actor: ActorContext,
): Promise<DataQuality> => {
  const parsed = dataExceptionEntity.safeParse(
    parseShortcode(input.entityId)?.type,
  );
  if (!parsed.success) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.entityId} cannot record data exceptions.`,
    );
  }
  const entityKind: DataExceptionEntity = parsed.data;
  if (dataCheckEntity[input.check] !== entityKind) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.check} does not apply to ${entityKind} data quality.`,
    );
  }
  if (
    "reason" in input &&
    !exceptionReasonsFor(input.check).includes(input.reason)
  ) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.reason} is not allowed for ${input.check}.`,
    );
  }
  const id = await resolveOrThrow(db, entityKind, input.entityId);
  const table = entryFor(entityKind).table;

  await withTransaction(db, async (tx) => {
    // `execute`, not the select builder: a single-table select renders its
    // selected columns unqualified, and the check's correlated subqueries
    // would then self-join (docs/agents/domain-rules.md).
    const probe = await tx.execute(sql`SELECT
  ${fingerprintSql(entityKind, input.check, table)} AS "fingerprint",
  ${gapCondition(entityKind, input.check, table)} AS "applies"
FROM ${table}
WHERE ${table.id} = ${id} AND ${notDeleted(table)}
LIMIT 1
FOR UPDATE`);
    const currentRow = probeRow.safeParse(probe.rows[0]);
    if (!currentRow.success) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[entityKind],
        `${entityKind} not found: ${input.entityId}`,
      );
    }
    const current = (
      await tx
        .select()
        .from(dataExceptionRecord)
        .where(eq(dataExceptionRecord.entityId, id))
        .orderBy(dataExceptionRecord.check)
    ).map(storedException);
    const currentFingerprint = currentRow.data.fingerprint;
    if ("reason" in input) {
      const currentlyActive = current.some(
        (item) =>
          item.check === input.check && item.fingerprint === currentFingerprint,
      );
      if (!currentlyActive && !currentRow.data.applies) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${input.check} is not an active ${entityKind} data gap.`,
        );
      }
    }
    const now = new Date();
    // Other exceptions retain their own evidence snapshot. Updating this row's
    // exception metadata is not evidence changing for a different check.
    const retained = current.filter((item) => item.check !== input.check);
    if ("reason" in input) {
      const note = input.note.trim();
      await tx
        .insert(dataExceptionRecord)
        .values({
          entityId: id,
          entityKind: entityKind,
          check: input.check,
          reason: input.reason,
          note,
          fingerprint: currentFingerprint,
        })
        .onConflictDoUpdate({
          target: [dataExceptionRecord.entityId, dataExceptionRecord.check],
          set: {
            reason: input.reason,
            note,
            fingerprint: currentFingerprint,
            updatedAt: now,
          },
        });
    } else {
      await tx
        .delete(dataExceptionRecord)
        .where(
          and(
            eq(dataExceptionRecord.entityId, id),
            eq(dataExceptionRecord.check, input.check),
          ),
        );
    }
    const next =
      "reason" in input
        ? [
            ...retained,
            {
              check: input.check,
              reason: input.reason,
              note: input.note.trim(),
              fingerprint: currentFingerprint,
            },
          ]
        : retained;
    await tx.execute(
      sql`UPDATE ${table} SET "updatedAt" = ${now} WHERE ${table.id} = ${id}`,
    );
    const changes = computeChanges(
      { dataExceptions: current },
      { dataExceptions: next },
      ["dataExceptions"],
    );
    if (changes && isAuditableEntity(entityKind)) {
      await logAuditEntry(tx, actor, {
        entityKind,
        entityId: id,
        action: "update",
        changes,
      });
    }
  });

  const quality = (await loadDataQualities(db, entityKind, [id])).get(id);
  if (!quality) {
    throw new Error(`Data quality was not loaded for ${input.entityId}`);
  }
  return quality;
};

export const setDataException = (
  db: Database,
  input: SetDataExceptionInput,
  actor: ActorContext,
) => mutateException(db, input, actor);

export const clearDataException = (
  db: Database,
  input: ClearDataExceptionInput,
  actor: ActorContext,
) => mutateException(db, input, actor);
