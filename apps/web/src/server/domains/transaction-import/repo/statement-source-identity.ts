import { sourceOccurrenceReviewState } from "@cubby/schemas/source-occurrence-fields";
import { sql } from "drizzle-orm";

import type { Database } from "~/server/db";
import { unwrapDb } from "~/server/db/helpers";
import { notDeleted } from "~/server/db/helpers/predicates";
import { requestedRows } from "~/server/db/helpers/requested";
import { sqlEnumConstant } from "~/server/db/sql-enum";
import {
  chargeId,
  type ChargeRef,
} from "~/server/domains/transaction-import/policy/charge-identity";
import { PROVIDER_IDENTITY_REVIEW } from "~/server/domains/transaction-import/policy/source-transaction-record-identity";
import { sourceObservationFacts } from "~/server/domains/transaction-import/repo/source-observation-state";
import { createAppError } from "~/server/errors/app-error";

/** Transfer matching accepts only ready retained occurrences with current evidence. */
export async function assertStatementSourceIdentity(
  db: Database,
  charges: readonly ChargeRef[],
  _creatingCharges: readonly ChargeRef[],
) {
  const unique = [
    ...new Map(charges.map((charge) => [chargeId(charge), charge])).values(),
  ];
  if (!unique.length) return;
  const wanted = requestedRows(
    unique,
    { source: "text", chargeKey: "text" },
    "requested_charge",
  );
  const rows = await unwrapDb(db).execute<{
    source: string;
    chargeKey: string;
  }>(
    sql`
    SELECT DISTINCT r.source, r."chargeKey" FROM ${sourceObservationFacts} r
    JOIN ${wanted.from} ON ${wanted.col("source")}=r.source AND ${wanted.col("chargeKey")}=r."chargeKey"
    WHERE ${notDeleted("r")} AND r."occurrenceId" IS NOT NULL AND r."reviewState"=${sqlEnumConstant(sourceOccurrenceReviewState, sourceOccurrenceReviewState.enum.ready)}
  `,
    "objects",
  );
  if (rows.length !== unique.length)
    throw createAppError("CONSTRAINT_VIOLATION", PROVIDER_IDENTITY_REVIEW);
}
