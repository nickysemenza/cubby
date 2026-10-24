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
import { and, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { withTransaction } from "~/server/db/helpers";
import { dataExceptionRecord } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import {
  computeChanges,
  logAuditEntry,
} from "~/server/generic/audit-log/repo/audit-log";
import { recordChange } from "~/server/generic/changes/repo/change";
import { exceptionReasonsFor } from "~/server/generic/data-quality/repo/exception-reasons";
import { liveQualityRow } from "~/server/generic/data-quality/repo/registry";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import { storedEntryFor } from "./entries";
import { loadDataQualities } from "./hydrate";
import { checksOf } from "./sql";
import { evaluateLiveQuality } from "./stored";

const storedException = (row: {
  check: string;
  reason: string;
  note: string;
}) =>
  dataException.parse({ check: row.check, reason: row.reason, note: row.note });

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
  const table = storedEntryFor(entityKind).table;

  await withTransaction(db, async (tx) => {
    // Lock the record so concurrent waiver edits serialize on it.
    const locked = await tx.execute(
      sql`SELECT 1 FROM ${table} WHERE ${table.id} = ${id} AND ${liveQualityRow(table)} FOR UPDATE`,
    );
    const [live] = locked.rows.length
      ? await evaluateLiveQuality(tx, storedEntryFor(entityKind), [id])
      : [];
    if (!live) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[entityKind],
        `${entityKind} not found: ${input.entityId}`,
      );
    }
    const current = (
      await tx
        .select()
        .from(dataExceptionRecord)
        .where(
          and(
            eq(dataExceptionRecord.entityId, id),
            inArray(dataExceptionRecord.check, [...checksOf(entityKind)]),
          ),
        )
        .orderBy(dataExceptionRecord.check)
    ).map(storedException);
    if ("reason" in input) {
      // An existing waiver may be edited; a new one needs a current gap.
      const state = live.checks[input.check];
      const waivable =
        current.some((item) => item.check === input.check) ||
        state === "gap" ||
        state === "waived";
      if (!waivable) {
        throw createAppError(
          "CONSTRAINT_VIOLATION",
          `${input.check} is not an active ${entityKind} data gap.`,
        );
      }
    }
    const now = new Date();
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
        })
        .onConflictDoUpdate({
          target: [dataExceptionRecord.entityId, dataExceptionRecord.check],
          set: {
            reason: input.reason,
            note,
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
            },
          ]
        : retained;
    await tx.execute(
      sql`UPDATE ${table} SET "updatedAt" = ${now} WHERE ${table.id} = ${id}`,
    );
    // A waiver changes the published check state; enroll the quality family.
    await recordChange(tx, { kind: "source", categories: [entityKind] });
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

  // The mutation response reflects the saved decision without repairing publication.
  const quality = (await loadDataQualities(db, entityKind, [id], "live")).get(
    id,
  );
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
