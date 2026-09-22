import { sql } from "drizzle-orm";

import { ledgerParty } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type LedgerParty = typeof ledgerParty;

const hasLiveFinancialAccount = (t: LedgerParty) => sql`EXISTS (
  SELECT 1 FROM "FinancialAccount" dq_lp_fa
  WHERE dq_lp_fa."ledgerPartyId" = ${t.id} AND dq_lp_fa."deletedAt" IS NULL
)`;

export const ledgerPartyChecks = defineEntityChecks({
  entity: "ledgerParty",
  table: ledgerParty,
  checks: {
    ledger_party_financial_account: {
      // Only a household member is expected to have a mapped financial
      // account; the household singleton and guest parties are not.
      expected: (t) => sql`${t.kind} = 'member'`,
      missing: (t) => sql`NOT ${hasLiveFinancialAccount(t)}`,
    },
  },
});
