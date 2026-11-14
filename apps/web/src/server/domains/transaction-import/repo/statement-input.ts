import { type FinancialTransactionImportRow } from "@cubby/schemas/financial-transaction";

import {
  chargeId,
  type ChargeRef,
} from "~/server/domains/transaction-import/policy/charge-identity";

/** Shared preview input for a charge's canonical observation. */
export const previewRowFor = (
  charge: ChargeRef,
  row: {
    source: string;
    accountDescriptor: string;
    statementDate: string;
    providerAmount: number;
    merchant: string | null;
    rawDescription: string;
    sourceCategory: string | null;
    providerNotes: string | null;
    importFingerprint: string;
    rowPosition: number | null;
    providerTransactionId: string | null;
    providerAccountId: string | null;
    providerStatus: "posted" | "pending" | null;
  },
): FinancialTransactionImportRow => ({
  key: chargeId(charge),
  source: row.source,
  account: row.accountDescriptor,
  date: row.statementDate,
  amount: row.providerAmount,
  merchant: row.merchant,
  originalStatement: row.rawDescription,
  category: row.sourceCategory,
  notes: row.providerNotes,
  importFingerprint: row.importFingerprint,
  ...(row.rowPosition === null ? {} : { rowPosition: row.rowPosition }),
  providerTransactionId: row.providerTransactionId,
  providerAccountId: row.providerAccountId,
  ...(row.providerStatus ? { providerStatus: row.providerStatus } : {}),
});
