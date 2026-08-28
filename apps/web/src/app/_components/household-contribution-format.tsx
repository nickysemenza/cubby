import type {
  HouseholdContributionGapCode,
  HouseholdContributionGapOut,
} from "@cubby/schemas/household-contribution";
import type { LedgerPartyKind } from "@cubby/schemas/ledger-party";
import { Link } from "@tanstack/react-router";

import { entityDetailLink } from "~/entities/entities";

export const ledgerPartyLabel = (kind: LedgerPartyKind) =>
  kind === "household" ? "Household" : kind === "member" ? "Member" : "Guest";

export const contributionGapLabels: Record<
  HouseholdContributionGapCode,
  string
> = {
  missing_beneficiaries: "No beneficiaries recorded",
  missing_funders: "No original funder recorded",
  partial_beneficiaries: "Some beneficiary share is unattributed",
  partial_funders: "Some original funding is unattributed",
  unpriced_expense: "Expense has no price",
  transfer_evidence_one_sided: "Transfer has evidence from only one side",
};

/** EXP- records have a browser detail route; route-less LTR- records remain text. */
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
        targetId
      )}
    </span>
  ));
}
