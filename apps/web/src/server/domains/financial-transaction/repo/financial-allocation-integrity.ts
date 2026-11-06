import {
  purchaseSettlementKindAllowedExpression,
  purchaseSettlementSignSatisfiedExpression,
} from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";

import { liveAliasSqlText } from "~/server/lib/live-row";

/**
 * Correlated predicate shared by the financial-transaction list and the
 * allocation detector. Keeping it in SQL makes page/count membership exact.
 */
export const allocationIntegrityDefectSql = (transactionAlias: string) => {
  const kindAllowed = purchaseSettlementKindAllowedExpression(
    `${transactionAlias}.kind`,
  );
  const signSatisfied = purchaseSettlementSignSatisfiedExpression({
    kind: `${transactionAlias}.kind`,
    amount: `${transactionAlias}."amountMinor"`,
  });
  return sql.raw(`EXISTS (
    SELECT 1
    FROM "FinancialTransactionAllocation" a
    WHERE a."transactionId" = ${transactionAlias}."id"
      AND ${liveAliasSqlText("a")}
    GROUP BY a."transactionId"
    HAVING
      (sum(a."amountMinor") IS DISTINCT FROM ${transactionAlias}."amountMinor")
      OR NOT (${kindAllowed})
      OR NOT (${signSatisfied})
      OR COALESCE(bool_or(sign(a."amountMinor") <> sign(${transactionAlias}."amountMinor")), false)
  )`);
};
