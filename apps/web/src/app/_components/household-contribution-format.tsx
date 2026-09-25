import type {
  HouseholdContributionGapCode,
  HouseholdContributionGapOut,
} from "@cubby/schemas/household-contribution";
import { Link } from "@tanstack/react-router";

import { TableCell } from "~/components/ui/table";
import { entityDetailLink } from "~/entities/entities";
import { formatCurrency } from "~/lib/utils";

export const contributionGapLabels = {
  missing_beneficiaries: "No beneficiaries recorded",
  missing_funders: "No original funder recorded",
  partial_beneficiaries: "Some beneficiary share is unattributed",
  partial_funders: "Some original funding is unattributed",
  unpriced_expense: "Expense has no price",
  transfer_evidence_one_sided: "Transfer has evidence from only one side",
  beneficiary_assumed_household: "Consumption assumed to be the household's",
  funder_account_unowned: "Paid from an account with no owner recorded",
  // "Committed" is the word BudgetStrip already uses for future spend on this
  // same page; two panels disagreeing about vocabulary is how this got
  // confusing in the first place.
  funder_not_yet_paid: "Committed, not yet paid",
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

/**
 * A right-aligned money cell, shared so the household ledger and the project
 * contribution panel render the same figure identically. Returns a `TableCell`,
 * so it only belongs inside a `Table`.
 */
export function MoneyCell({
  value,
  strong = false,
  empty,
}: {
  value: number | undefined;
  strong?: boolean;
  empty?: string;
}) {
  return (
    <TableCell
      className={`text-right font-mono text-xs tabular-nums ${strong ? "font-semibold text-foreground" : ""}`}
    >
      {value === undefined ? empty : formatCurrency(value)}
    </TableCell>
  );
}
