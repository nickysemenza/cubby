import { sql } from "drizzle-orm";

import { ledgerTransfer } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type LedgerTransfer = typeof ledgerTransfer;

// A voided transaction never moved money, so it evidences nothing.
const hasLiveTransaction = (t: LedgerTransfer) => sql`EXISTS (
  SELECT 1 FROM "FinancialTransaction" dq_lt_ft
  WHERE dq_lt_ft."ledgerTransferId" = ${t.id} AND dq_lt_ft."deletedAt" IS NULL
    AND dq_lt_ft."status" <> 'void'
)`;

export const ledgerTransferChecks = defineEntityChecks({
  entity: "ledgerTransfer",
  table: ledgerTransfer,
  checks: {
    ledger_transfer_transaction: {
      // A hand-to-hand cash transfer has no statement to evidence it; that
      // is a reasoned exception, not a reason to stop expecting evidence.
      missing: (t) => sql`NOT ${hasLiveTransaction(t)}`,
      fingerprint: (t) => [hasLiveTransaction(t)],
    },
  },
});
