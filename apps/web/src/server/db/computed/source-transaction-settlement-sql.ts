import { entitySchema } from "@cubby/schemas/entity-core";
import { sql } from "drizzle-orm";

import { notDeleted } from "~/server/db/helpers/predicates";

/**
 * Accepted references identify a charge across its retained observation versions.
 * Explicit ANY keeps both aliases searchable by the compound external-id index;
 * IN with column expressions becomes an OR that repeatedly scans source/kind.
 */
export const sourceTransactionSettlements = sql`SELECT DISTINCT record.id AS "record", ft.id AS "transaction"
  FROM "SourceTransactionRecord" record
  JOIN "SourceTransactionRecord" observation ON observation.source = record.source
    AND observation."chargeKey" = record."chargeKey" AND ${notDeleted("observation")}
  JOIN "EntityExternalId" ref ON ref.source = observation.source AND ref.kind = 'settlement_ref'
    AND ref."entityKind" = ${entitySchema.enum.financialTransaction} AND ${notDeleted("ref")}
    AND ref."externalId" = ANY(ARRAY[observation."externalId", observation."legacyReference"])
  JOIN "FinancialTransaction" ft ON ft.id = ref."entityId" AND ${notDeleted("ft")}
  WHERE ${notDeleted("record")}`;
