import type {
  HouseholdContributionGapCode,
  HouseholdContributionGapOut,
} from "@cubby/schemas/household-contribution";
import type { LedgerPartyKind } from "@cubby/schemas/ledger-party";
import { Link } from "@tanstack/react-router";

import { entityDetailLink } from "~/entities/entities";

export const ledgerPartyLabel = (kind: LedgerPartyKind) =>
  kind === "household" ? "Household" : kind === "member" ? "Member" : "Guest";

export const contributionGapLabels = {
  missing_beneficiaries: "No beneficiaries recorded",
  missing_funders: "No original funder recorded",
  partial_beneficiaries: "Some beneficiary share is unattributed",
  partial_funders: "Some original funding is unattributed",
  unpriced_expense: "Expense has no price",
  transfer_evidence_one_sided: "Transfer has evidence from only one side",
  beneficiary_assumed_household: "Consumption assumed to be the household's",
  funder_account_unowned: "Paid from an account with no owner recorded",
} satisfies Record<HouseholdContributionGapCode, string>;

/** Both EXP- and LTR- records now have browser detail routes. */
export function ContributionGapTargets({
  targetIds,
}: {
  targetIds: HouseholdContributionGapOut["targetIds"];
}) {
  return targetIds.map((targetId, index) => (
    <span key={targetId}>
      {index > 0 && ", "}
      {targetId.startsWith("EXP-") ? (
        <Link
          className="text-primary hover:underline"
          {...entityDetailLink("expense", targetId)}
        >
          {targetId}
        </Link>
      ) : (
        <Link
          className="text-primary hover:underline"
          {...entityDetailLink("ledgerTransfer", targetId)}
        >
          {targetId}
        </Link>
      )}
    </span>
  ));
}
