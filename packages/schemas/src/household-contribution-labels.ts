import type { HouseholdContributionGapCode } from "./household-contribution";

/**
 * Display text for each gap, shared by the web tables and the server-composed project report.
 * Its own module so the always-loaded contract schema does not carry the strings.
 */
export const contributionGapLabels = {
  missing_beneficiaries: "No beneficiaries recorded",
  missing_funders: "No original funder recorded",
  partial_beneficiaries: "Some beneficiary share is unattributed",
  partial_funders: "Some original funding is unattributed",
  unpriced_expense: "Expense has no price",
  transfer_evidence_one_sided: "Transfer has evidence from only one side",
  beneficiary_assumed_household: "Consumption assumed to be the household's",
  funder_account_unowned: "Paid from an account with no owner recorded",
  // "Committed" is the word the project budget uses for future spend; two
  // panels disagreeing about vocabulary is how this got confusing.
  funder_not_yet_paid: "Committed, not yet paid",
} satisfies Record<HouseholdContributionGapCode, string>;
