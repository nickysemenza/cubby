import { financialAccount } from "~/server/db/retained-tables";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadFinancialAccountQualityRecords = qualityCheck.records(
  "financialAccount",
  financialAccount,
  {
    ledgerPartyId: financialAccount.ledgerPartyId,
  },
);

/** Bump when the rules or their declared scoring metadata change. */
const FINANCIAL_ACCOUNT_QUALITY_RULES_VERSION = 2;
type FinancialAccountQualityRecord = Awaited<
  ReturnType<typeof loadFinancialAccountQualityRecords>
>[number];
const observed = qualityCheck.observed<FinancialAccountQualityRecord>;

export const financialAccountChecks = defineStoredEntityChecks({
  entity: "financialAccount",
  table: financialAccount,
  rulesVersion: FINANCIAL_ACCOUNT_QUALITY_RULES_VERSION,
  load: loadFinancialAccountQualityRecords,
  checks: {
    financialaccount_display_image: qualityCheck.hasImage,
    financial_account_ledger_party: observed((r) => r.ledgerPartyId !== null),
  },
});
