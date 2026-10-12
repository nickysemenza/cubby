import {
  spendingCategorySummaryLabels,
  type SpendingCategorySummary,
} from "@cubby/schemas/spending-classification";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { formatCurrency } from "~/lib/utils";
import { ChipCluster } from "~/ui/common/chip-cluster";
import { Row, Stack } from "~/ui/layout";

const compactSummaryLabels = {
  ...spendingCategorySummaryLabels,
  partial: "Partial",
} satisfies Record<SpendingCategorySummary["state"], string>;

export function SpendingCategorySummaryValue({
  summary,
  contextOnly = false,
  compact = false,
}: {
  summary: SpendingCategorySummary;
  contextOnly?: boolean;
  compact?: boolean;
}) {
  if (compact)
    // Dense list rows: the chips are the value. Chips need no state word when
    // they say it themselves (one category, or several: mixed); a muted state
    // names what the chips cannot (partial, unclassified, not applicable).
    return (
      <ChipCluster
        leading={
          summary.state === "single" || summary.state === "mixed"
            ? undefined
            : compactSummaryLabels[summary.state]
        }
        items={summary.categories.map((category) => ({
          key: category.id,
          label: category.name,
          node: (
            <EntityRefLink
              variant="chip"
              compact
              entity="spendingCategory"
              id={category.id}
              name={category.name}
              displayImage={null}
            />
          ),
        }))}
      />
    );
  return (
    <Stack gap="xs">
      <span className="text-sm font-medium">
        {spendingCategorySummaryLabels[summary.state]}
      </span>
      {summary.state !== "not_applicable" && (
        <p className="text-xs text-muted-foreground">
          {summary.lineCount === 0
            ? "No linked expense lines."
            : `${summary.categorizedLineCount} of ${summary.lineCount} expense lines classified.`}
        </p>
      )}
      {summary.categories.map((category) => (
        <Row key={category.id} justify="between" gap="sm">
          <EntityRefLink
            variant="chip"
            entity="spendingCategory"
            id={category.id}
            name={category.name}
            displayImage={null}
          />
          {!contextOnly && category.amount !== null && (
            <span className="shrink-0 tabular-nums">
              {formatCurrency(category.amount)}
            </span>
          )}
        </Row>
      ))}
      {summary.categories.length > 0 && contextOnly && (
        <p className="text-xs text-muted-foreground">
          Categories describe linked expenses. Settlement amounts are not
          attributed to categories.
        </p>
      )}
      {summary.categories.length > 0 &&
        !contextOnly &&
        !summary.amountsKnown && (
          <p className="text-xs text-muted-foreground">
            Some expense amounts are unknown.
          </p>
        )}
    </Stack>
  );
}

export const renderSpendingCategorySummary = (
  summary: SpendingCategorySummary,
  contextOnly = false,
) => (
  <SpendingCategorySummaryValue summary={summary} contextOnly={contextOnly} />
);
