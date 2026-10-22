import type { HouseholdContributionGapOut } from "@cubby/schemas/household-contribution";
import { contributionGapLabels } from "@cubby/schemas/household-contribution-labels";
import { countLabel } from "@cubby/shared/pluralize";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { Link } from "@tanstack/react-router";

import { entityDetailLink } from "~/entity/entities";
import { formatCurrency } from "~/lib/number-format";
import { Row } from "~/ui/layout";
import { StaticTable } from "~/ui/primitives/static-table";

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

/** The gap list shared by the household ledger and the project contribution panel. */
export function ContributionGapsTable({
  gaps,
}: {
  gaps: HouseholdContributionGapOut[];
}) {
  return (
    <StaticTable
      rows={gaps}
      rowKey={(gap) => `${gap.code}:${gap.targetIds.join(":")}`}
      columns={[
        {
          id: "column-0",
          header: "Issue",
          cellClassName: "whitespace-normal",
          cell: (gap) => (
            <Row align="center" gap="xs">
              <WarningIcon className="size-3.5 shrink-0 text-warning-ink" />
              {contributionGapLabels[gap.code]}
            </Row>
          ),
        },
        {
          id: "column-1",
          header: "Amount",
          headClassName: "w-28 text-right",
          cellClassName: "text-right font-mono text-xs tabular-nums",
          cell: (gap) =>
            gap.amount === undefined ? "—" : formatCurrency(gap.amount),
        },
        {
          id: "column-2",
          header: "Records",
          headClassName: "w-48",
          cellClassName: "font-mono text-2xs text-muted-foreground",
          cell: (gap) => (
            <>
              {/* Aggregated codes stand for many expenses and carry no
                  targets — a count is the honest thing to show. */}
              {gap.count === undefined ? (
                <ContributionGapTargets targetIds={gap.targetIds} />
              ) : (
                countLabel(gap.count, "expense")
              )}
            </>
          ),
        },
      ]}
    />
  );
}
