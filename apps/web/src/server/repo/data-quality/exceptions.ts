import type { ActorContext } from "@cubby/schemas/context";
import {
  type ClearDataExceptionInput,
  type DataCheck,
  type DataExceptionEntity,
  type DataExceptionReason,
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

import { loadDataQualities } from "./hydrate";
import { entryFor, fingerprintSql, gapCondition } from "./sql";

const EXCEPTION_REASONS = {
  order_id: ["not_issued", "unavailable"],
  stated_total: ["not_issued", "unavailable"],
  primary_document: ["not_issued", "unavailable", "history_expired"],
  empty_expenses: ["unavailable", "history_expired"],
  settlement_reference: ["not_applicable", "insufficient_detail"],
  // Settlement evidence and the expense ledger can both be correct while a
  // source leaves a small residual. This is never a tolerance: it requires a
  // reasoned, evidence-bound exception and reopens on any evidence change.
  settlement_mismatch: ["expected_mismatch"],
  paperwork_mismatch: ["expected_mismatch"],
  amazon_asin: ["unavailable", "insufficient_detail"],
  // A check absent from this map admits NO reason at all, so its gap can never
  // be closed even when the fact provably does not exist. The three identity
  // checks below sat in that state: a kit component the manufacturer never
  // catalogued separately (for example, an unbranded carrying bag) has no model
  // number to record, and no exception could say so.
  product_manufacturer: ["not_applicable", "unavailable"],
  product_category: ["not_applicable", "insufficient_detail"],
  product_model: ["not_issued", "unavailable"],
  product_external_id: ["not_issued", "unavailable"],
  // `unavailable` is the common one and the reason this check earns its keep:
  // a discontinued item whose listings are all retired has NO canonical asset,
  // and substituting a neighbouring generation is worse than no image because
  // the swap is undetectable later. Before this check existed that finding had
  // nowhere to live but free-text notes, so every sweep re-researched the same
  // dead ends. `not_applicable` covers a `misc:` bucket row, which is a
  // stocked pseudo-product that no single photograph describes.
  product_image: ["unavailable", "not_applicable"],
  // A regional or defunct vendor can have no mark or site worth recording.
  vendor_logo: ["unavailable"],
  vendor_website: ["unavailable", "not_applicable"],
  vendor_order_evidence: ["not_applicable"],
} satisfies Partial<Record<DataCheck, readonly DataExceptionReason[]>>;

const reasonsFor = (check: DataCheck): readonly DataExceptionReason[] =>
  Object.entries(EXCEPTION_REASONS).find(([key]) => key === check)?.[1] ?? [];

const probeRow = z.object({
  fingerprint: z.string(),
  applies: z.boolean(),
});

const storedException = (row: {
  check: string;
  reason: string;
  note: string;
  fingerprint: string | null;
}) => {
  const base = { check: row.check, reason: row.reason, note: row.note };
  // A legacy exception has no fingerprint; the read schema keeps it absent.
  return dataException.parse(
    row.fingerprint === null ? base : { ...base, fingerprint: row.fingerprint },
  );
};

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
  const entityType: DataExceptionEntity = parsed.data;
  if (dataCheckEntity[input.check] !== entityType) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.check} does not apply to ${entityType} data quality.`,
    );
  }
  if ("reason" in input && !reasonsFor(input.check).includes(input.reason)) {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.reason} is not allowed for ${input.check}.`,
    );
  }
  const id = await resolveOrThrow(db, entityType, input.entityId);
  const table = entryFor(entityType).table;

  await withTransaction(db, async (tx) => {
    // `execute`, not the select builder: a single-table select renders its
    // selected columns unqualified, and the check's correlated subqueries
    // would then self-join (docs/agents/domain-rules.md).
    const probe = await tx.execute(sql`SELECT
  ${fingerprintSql(entityType, input.check, table)} AS "fingerprint",
  ${gapCondition(entityType, input.check, table)} AS "applies"
FROM ${table}
WHERE ${table.id} = ${id} AND ${notDeleted(table)}
LIMIT 1
FOR UPDATE`);
    const currentRow = probeRow.safeParse(probe.rows[0]);
    if (!currentRow.success) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[entityType],
        `${entityType} not found: ${input.entityId}`,
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
          `${input.check} is not an active ${entityType} data gap.`,
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
          entityKind: entityType,
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
    if (changes && isAuditableEntity(entityType)) {
      await logAuditEntry(tx, actor, {
        entityType,
        entityId: id,
        action: "update",
        changes,
      });
    }
  });

  const quality = (await loadDataQualities(db, entityType, [id])).get(id);
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
