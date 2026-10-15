import {
  purchaseSettlementKindAllowedExpression,
  purchaseSettlementSignSatisfiedExpression,
} from "@cubby/schemas/financial-transaction";
import { sql } from "drizzle-orm";

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
    amount: `${transactionAlias}.amount`,
  });
  return sql.raw(`EXISTS (
    SELECT 1
    FROM "FinancialTransactionAllocation" a
    WHERE a."transactionId" = ${transactionAlias}."id"
      AND a."deletedAt" IS NULL
    GROUP BY a."transactionId"
    HAVING
      (round((sum(a."amount") * 100)::numeric) IS DISTINCT FROM round((${transactionAlias}."amount" * 100)::numeric))
      OR NOT (${kindAllowed})
      OR NOT (${signSatisfied})
      OR COALESCE(bool_or(sign(a."amount") <> sign(${transactionAlias}."amount")), false)
  )`);
};
