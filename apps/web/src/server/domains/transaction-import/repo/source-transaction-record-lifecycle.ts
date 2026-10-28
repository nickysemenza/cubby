import { entitySchema } from "@cubby/schemas/entity";
import { sql } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { createAppError } from "~/server/errors/app-error";

/** Settlement references are strings; a row FK cannot protect the charge's aliases. */
export async function assertSourceTransactionRecordDeletionAllowed(
  db: Database | DrizzleTransaction,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const selected = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const { rows } = await unwrapDb(db).execute<{
    predecessor: boolean;
    settlement: boolean;
  }>(sql`
    -- includes-deleted: historical observations retain accepted settlement aliases.
    SELECT
      EXISTS (SELECT 1 FROM "SourceTransactionRecord" predecessor
        WHERE predecessor."supersededByRowId" IN (${selected}) AND predecessor.id NOT IN (${selected})
          AND ${notDeleted("predecessor")}) AS predecessor,
      -- includes-deleted: accepted charge aliases survive historical observation deletion.
      EXISTS (
        SELECT 1 FROM "SourceTransactionRecord" target
        -- includes-deleted: historical observations retain accepted settlement aliases.
        JOIN "SourceTransactionRecord" observation ON observation.source = target.source
          AND observation."chargeKey" = target."chargeKey"
        JOIN "EntityExternalId" ref ON ref.source = target.source AND ref.kind = 'settlement_ref'
          AND ${notDeleted("ref")} AND ref."entityKind" = ${entitySchema.enum.financialTransaction}
          AND ref."externalId" IN (observation."externalId", observation."legacyReference")
        JOIN "FinancialTransaction" ft ON ft.id = ref."entityId" AND ${notDeleted("ft")}
        WHERE target.id IN (${selected}) AND ${notDeleted("target")}
      ) AS settlement
  `);
  if (rows[0]?.predecessor)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A live source record still names the selected superseding record.",
    );
  if (rows[0]?.settlement)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A live FinancialTransaction retains settlement evidence for the selected source charge.",
    );
}

/** A supersession follows one same-source chain and cannot point back to its predecessor. */
export async function assertSourceTransactionRecordSupersessionAllowed(
  db: Database | DrizzleTransaction,
  predecessor: { id: string; source: string },
  successorId: string,
): Promise<void> {
  const { rows } = await unwrapDb(db).execute<{
    sameSource: boolean;
    cycle: boolean;
  }>(sql`
    WITH RECURSIVE chain AS (
      SELECT r.id, r.source, r."supersededByRowId", ARRAY[r.id] AS path
      FROM "SourceTransactionRecord" r WHERE r.id = ${successorId}::uuid AND ${notDeleted("r")}
      UNION ALL
      SELECT r.id, r.source, r."supersededByRowId", chain.path || r.id
      FROM chain JOIN "SourceTransactionRecord" r ON r.id = chain."supersededByRowId"
      WHERE ${notDeleted("r")} AND NOT r.id = ANY(chain.path)
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${successorId}::uuid AND source = ${predecessor.source}) AS "sameSource",
      EXISTS (SELECT 1 FROM chain WHERE id = ${predecessor.id}::uuid) AS cycle
  `);
  if (!rows[0]?.sameSource)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "A superseding source record must be live and belong to the same source.",
    );
  if (rows[0]?.cycle)
    throw createAppError(
      "CONSTRAINT_VIOLATION",
      "Source record supersession cannot link to itself or form a cycle.",
    );
}
