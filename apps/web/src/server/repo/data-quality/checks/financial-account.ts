import { sql } from "drizzle-orm";

import { financialAccount } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type FinancialAccount = typeof financialAccount;

export const financialAccountChecks = defineEntityChecks({
  entity: "financialAccount",
  table: financialAccount,
  checks: {
    financial_account_ledger_party: {
      missing: (t: FinancialAccount) => sql`${t.ledgerPartyId} IS NULL`,
    },
    financial_account_confirmed: {
      missing: (t: FinancialAccount) => sql`${t.provisional} = true`,
    },
  },
});
