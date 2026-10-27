import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { notDeleted } from "~/server/db/helpers/predicates";
import {
  financialAccount,
  sourceTransactionRecord,
  transactionImport,
} from "~/server/db/schema";
import { transactionImportMembers } from "~/server/domains/transaction-import/repo/transaction-import-membership";
import { findIncompleteTransactionImports } from "~/server/generic/problems/repo/detectors-financial";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";
const source: WorkSource = {
  id: "incompleteTransactionImports",
  family: "account",
  executor: "human",
  entity: null,
  link: { kind: "reason" },
  reasons: [
    {
      key: "incompleteTransactionImports",
      label: "Incomplete statement imports",
    },
  ],
  candidates: async (db, scope) => {
    if (scope.record) return null;
    const queries = (await findIncompleteTransactionImports(db)).map(
      (incomplete) => {
        const owners = sql`coalesce((
      SELECT array_agg(DISTINCT account."ledgerPartyId")
      FROM "TransactionImport" batch
      JOIN ${transactionImportMembers} member ON member."importId" = batch.id
      JOIN "SourceTransactionRecord" row ON row.id = member."statementRowId" AND ${notDeleted(alias(sourceTransactionRecord, "row"))}
      LEFT JOIN "FinancialAccount" account ON account.id = row."accountId" AND ${notDeleted(alias(financialAccount, "account"))}
      WHERE batch.source = ${incomplete.source} AND batch.fingerprint = ${incomplete.fingerprint} AND ${notDeleted(alias(transactionImport, "batch"))}
    ), ARRAY[NULL::uuid])`;
        return selectWorkCandidates(db, source, {
          entity: null,
          id: null,
          key: `problem:incompleteTransactionImports:${incomplete.source}:${incomplete.fingerprint}`,
          name: sql`${incomplete.label}`,
          owners,
          reason: `Statement import retained ${incomplete.rowCountStored} of ${incomplete.rowCountDeclared} declared rows.`,
          reasonKeys: [source.id],
        }).from(sql`(SELECT 1) incomplete`);
      },
    );
    return queries.length
      ? {
          query: sql.join(
            queries.map((query) => sql`(${query})`),
            sql` UNION ALL `,
          ),
        }
      : null;
  },
};
export const transactionImportWorkSources = [source];
