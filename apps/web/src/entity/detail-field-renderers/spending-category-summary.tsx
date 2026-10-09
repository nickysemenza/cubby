import {
  spendingCategorySummaryLabels,
  type SpendingCategorySummary,
} from "@cubby/schemas/spending-classification";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { formatCurrency } from "~/lib/utils";
import { Row, Stack } from "~/ui/layout";

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
    // Dense list rows: state and category chips on one line.
    return (
      <Row gap="sm" className="min-w-0 overflow-hidden whitespace-nowrap">
        <span className="shrink-0 font-medium">
          {spendingCategorySummaryLabels[summary.state]}
        </span>
        {summary.categories.map((category) => (
          <EntityRefLink
            key={category.id}
            variant="chip"
            entity="spendingCategory"
            id={category.id}
            name={category.name}
            displayImage={null}
          />
        ))}
      </Row>
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
