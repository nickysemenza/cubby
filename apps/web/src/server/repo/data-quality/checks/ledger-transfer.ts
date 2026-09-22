import { sql } from "drizzle-orm";

import { ledgerTransfer } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type LedgerTransfer = typeof ledgerTransfer;

const hasLiveTransaction = (t: LedgerTransfer) => sql`EXISTS (
  SELECT 1 FROM "FinancialTransaction" dq_lt_ft
  WHERE dq_lt_ft."ledgerTransferId" = ${t.id} AND dq_lt_ft."deletedAt" IS NULL
)`;

export const ledgerTransferChecks = defineEntityChecks({
  entity: "ledgerTransfer",
  table: ledgerTransfer,
  checks: {
    ledger_transfer_transaction: {
      missing: (t) => sql`NOT ${hasLiveTransaction(t)}`,
    },
  },
});
