import type { HouseholdContributionGapOut } from "@cubby/schemas/household-contribution";
import { contributionGapLabels } from "@cubby/schemas/household-contribution-labels";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { Link } from "@tanstack/react-router";

import { entityDetailLink } from "~/entity/entities";
import { countLabel } from "~/lib/pluralize";
import { formatCurrency } from "~/lib/utils";
import { Row } from "~/ui/layout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/ui/primitives/table";

/** Both EXP- and LTR- records now have browser detail routes. */
function ContributionGapTargets({
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

/** The gap list shared by the household ledger and the project contribution panel. */
export function ContributionGapsTable({
  gaps,
}: {
  gaps: HouseholdContributionGapOut[];
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Issue</TableHead>
          <TableHead className="w-28 text-right">Amount</TableHead>
          <TableHead className="w-48">Records</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {gaps.map((gap) => (
          <TableRow key={`${gap.code}:${gap.targetIds.join(":")}`}>
            {/* Table defaults to table-fixed with nowrap cells, and the
                project panel's column is narrow, so labels must wrap. */}
            <TableCell className="whitespace-normal">
              <Row align="center" gap="xs">
                <WarningIcon className="size-3.5 shrink-0 text-warning-ink" />
                {contributionGapLabels[gap.code]}
              </Row>
            </TableCell>
            <MoneyCell value={gap.amount} empty="—" />
            <TableCell className="font-mono text-2xs text-muted-foreground">
              {/* Aggregated codes stand for many expenses and carry no
                  targets — a count is the honest thing to show. */}
              {gap.count === undefined ? (
                <ContributionGapTargets targetIds={gap.targetIds} />
              ) : (
                countLabel(gap.count, "expense")
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
