import type { HouseholdContributionGapOut } from "@cubby/schemas/household-contribution";
import { Link } from "@tanstack/react-router";

import { entityDetailLink } from "~/entity/entities";
import { formatCurrency } from "~/lib/utils";
import { TableCell } from "~/ui/primitives/table";

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
