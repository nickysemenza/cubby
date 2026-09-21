import type { ActorContext } from "@cubby/schemas/context";
import {
  type ClearDataExceptionInput,
  type DataCheck,
  type DataExceptionReason,
  type DataQuality,
  dataCheckEntity,
  dataException,
  type SetDataExceptionInput,
} from "@cubby/schemas/data-quality";
import {
  ENTITY_NOT_FOUND_REASON,
  parseEntityId,
} from "@cubby/schemas/identifiers";
import { parseShortcode } from "@cubby/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import { product, purchase } from "~/server/db/schema";
import { createAppError } from "~/server/errors/app-error";
import { computeChanges, logAuditEntry } from "~/server/repo/audit-log";
import {
  notDeleted,
  updateLiveAndReturn,
  withTransaction,
} from "~/server/repo/database-helpers";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";

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
} satisfies Partial<Record<DataCheck, readonly DataExceptionReason[]>>;

const reasonsFor = (check: DataCheck): readonly DataExceptionReason[] =>
  Object.entries(EXCEPTION_REASONS).find(([key]) => key === check)?.[1] ?? [];

/** Only these two tables carry `dataExceptions`; see `dataExceptionEntity`. */
type ExceptionEntity = "purchase" | "product";
const exceptionTable = { purchase, product } as const;

const probeRow = z.object({
  dataExceptions: z.array(dataException),
  fingerprint: z.string(),
  applies: z.boolean(),
});

const mutateException = async (
  db: Database,
  input: SetDataExceptionInput | ClearDataExceptionInput,
  actor: ActorContext,
): Promise<DataQuality> => {
  const parsed = parseShortcode(input.entityId);
  if (parsed?.type !== "purchase" && parsed?.type !== "product") {
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      `${input.entityId} is not a Purchase or Product.`,
    );
  }
  // Captured after the guard above: the narrowing to purchase|product is lost
  // inside the transaction closure below, and that only started mattering once
  // `image` joined ShortcodeType without being auditable — so the un-narrowed
  // type no longer satisfies the audit entity union.
  const entityType: ExceptionEntity = parsed.type;
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
  const resolved = await resolveLiveShortcode(db, input.entityId, entityType);
  if (!resolved) {
    throw createAppError(
      ENTITY_NOT_FOUND_REASON[entityType],
      `${entityType} not found: ${input.entityId}`,
    );
  }
  const id = parseEntityId(entityType, resolved);
  const table = exceptionTable[entityType];
  const entry = entryFor(entityType);
  const exceptionsColumn = entry.exceptions?.(table);
  if (!exceptionsColumn)
    throw new Error(`${entityType} declares no dataExceptions column.`);

  await withTransaction(db, async (tx) => {
    // `execute`, not the select builder: a single-table select renders its
    // selected columns unqualified, and the check's correlated subqueries
    // would then self-join (docs/agents/domain-rules.md).
    const probe = await tx.execute(sql`SELECT
  ${exceptionsColumn} AS "dataExceptions",
  ${fingerprintSql(entityType, input.check, table)} AS "fingerprint",
  ${gapCondition(entityType, input.check, table)} AS "applies"
FROM ${table}
WHERE ${table.id} = ${id} AND ${notDeleted(table)}
LIMIT 1`);
    const currentRow = probeRow.safeParse(probe.rows[0]);
    if (!currentRow.success) {
      throw createAppError(
        ENTITY_NOT_FOUND_REASON[entityType],
        `${entityType} not found: ${input.entityId}`,
      );
    }
    const current = currentRow.data.dataExceptions;
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
    if (entityType === "purchase") {
      await updateLiveAndReturn(
        tx,
        purchase,
        { dataExceptions: next, updatedAt: now },
        parseEntityId("purchase", resolved),
      );
    } else {
      await updateLiveAndReturn(
        tx,
        product,
        { dataExceptions: next, updatedAt: now },
        parseEntityId("product", resolved),
      );
    }
    const changes = computeChanges(
      { dataExceptions: current },
      { dataExceptions: next },
      ["dataExceptions"],
    );
    if (changes) {
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
