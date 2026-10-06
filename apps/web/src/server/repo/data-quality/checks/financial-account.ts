import { sql } from "drizzle-orm";

import { financialAccount } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type FinancialAccount = typeof financialAccount;

export const financialAccountChecks = defineEntityChecks({
  entity: "financialAccount",
  table: financialAccount,
  checks: {
    financial_account_unclaimed: {
      // Cash has no provider to claim it; the account itself is the evidence
      // (the same rule `settlement_reference` applies).
      missing: (t: FinancialAccount) => sql`(${t.provisional} = true
        AND ${t.identity}->>'kind' <> 'cash'
        AND CASE WHEN jsonb_typeof(${t.sourceAliases}) = 'array' THEN jsonb_array_length(${t.sourceAliases}) ELSE 0 END = 0
        AND NOT EXISTS (
          SELECT 1 FROM "FinancialTransaction" ft
          JOIN "EntityExternalId" fx ON fx."entityId" = ft.id
            AND fx.kind = 'settlement_ref' AND fx."deletedAt" IS NULL
          WHERE ft."accountId" = ${t.id} AND ft."deletedAt" IS NULL
        ))`,
    },
    financial_account_ledger_party: {
      missing: (t: FinancialAccount) => sql`${t.ledgerPartyId} IS NULL`,
    },
    financial_account_confirmed: {
      missing: (t: FinancialAccount) => sql`${t.provisional} = true`,
    },
  },
});
