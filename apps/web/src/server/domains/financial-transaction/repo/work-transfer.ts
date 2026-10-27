import {
  financialTransactionStatus,
  financialTransactionKind,
} from "@cubby/schemas/financial-transaction";
import { workExecutor } from "@cubby/schemas/work-queue";
import { and, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import { related, outer, quotedTable } from "~/server/db/helpers/related";
import {
  financialTransaction,
  financialTransactionAllocation,
} from "~/server/db/schema";
import {
  financialTransactionWorkFacts,
  financialTransactionWorkOwners,
} from "~/server/domains/financial-transaction/repo/work-facts";
import {
  awaitingPostingSql,
  transactionPostingStartSql,
} from "~/server/domains/purchase/repo/settlement-grace";
import { recordScope } from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";
const source: WorkSource = {
  id: "reconciliation:transfer",
  family: "reconciliation",
  executor: "dynamic",
  entity: "financialTransaction",
  link: { kind: "record" },
  actions: [
    {
      id: "pair-transfer",
      label: "Pair transfer",
      scope: "item",
      target: "guided-flow",
    },
  ],
  reasons: [
    {
      key: "reconciliation:transfer",
      label: "Account transfer has no confirmed transfer evidence.",
    },
    {
      key: "awaiting_posting:reconciliation:transfer",
      label: "Awaiting posting of transfer evidence.",
    },
  ],
  candidates: async (db, scope) => {
    const deferred = awaitingPostingSql(
      transactionPostingStartSql(quotedTable(financialTransaction)),
    );
    return {
      query: selectWorkCandidates(db, source, {
        entity: "financialTransaction",
        id: sql`${financialTransaction.shortcode}`,
        name: sql`coalesce("FinancialTransaction".merchant, "FinancialTransaction"."rawDescription", 'Account transfer')`,
        owners: financialTransactionWorkOwners(sql`"FinancialTransaction".id`),
        ...financialTransactionWorkFacts(),
        executor: sql`CASE WHEN ${deferred} THEN ${workExecutor.enum.external} ELSE ${workExecutor.enum.human} END`,
        reason: sql`CASE WHEN ${deferred} THEN ${source.reasons[1]!.label} ELSE ${source.reasons[0]!.label} END`,
        reasonKeys: sql`ARRAY[CASE WHEN ${deferred} THEN ${source.reasons[1]!.key} ELSE ${source.reasons[0]!.key} END]`,
      })
        .from(financialTransaction)
        .where(
          and(
            sql`${notDeleted(alias(financialTransaction, "FinancialTransaction"))} AND "FinancialTransaction".status <> ${financialTransactionStatus.enum.void}
        AND "FinancialTransaction".kind = ${financialTransactionKind.enum.account_transfer} AND "FinancialTransaction"."ledgerTransferId" IS NULL
        AND NOT ${related(financialTransactionAllocation, (allocation) => sql`${allocation.transactionId} = ${outer(financialTransaction.id)}`).exists()}`,
            recordScope(scope, sql`${financialTransaction.shortcode}`),
          ),
        ),
    };
  },
};
export const transferWorkSource = source;
