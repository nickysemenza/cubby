import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { fieldDecisionOf } from "@cubby/schemas/field-envelope";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { renderDetailFieldValue } from "~/entity/display/entity-display";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { formatCurrency } from "~/lib/number-format";
import { Stack } from "~/ui/layout";

import type { EntityDetailFieldRenderers } from "../../entity/display/detail-field-renderers/index";

const categoryField = entityFieldModels.expense.fields.find(
  (field) => field.key === "spendingCategoryId",
);

const projectField = entityFieldModels.expense.fields.find(
  (field) => field.key === "projectId",
);

/** Allocated projects retain their per-share amounts; proposals use the shared queue. */
function ExpenseProjectField({ expense }: { expense: ExpenseOut }) {
  // Regression: without min-w-0, a share's project link did not truncate and
  // pushed its amount past the two-column facts.
  return (
    <Stack gap="xs" className="min-w-0">
      {fieldDecisionOf(expense.fields.projectId)?.provenance?.kind ===
      "allocated" ? (
        <Stack gap="xs" className="min-w-0">
          {(expense.projectAllocations ?? []).map((share) => (
            <div
              key={share.projectId ?? "unassigned"}
              className="flex min-w-0 items-baseline justify-between gap-3"
            >
              {share.projectId ? (
                <EntityRefLink
                  entity="project"
                  data={{
                    id: share.projectId,
                    name: share.projectName ?? share.projectId,
                  }}
                />
              ) : (
                <span>Unassigned</span>
              )}
              <span className="shrink-0 font-mono tabular-nums">
                {share.amount === null
                  ? "Unpriced"
                  : formatCurrency(share.amount)}
              </span>
            </div>
          ))}
          {expense.projectAllocations?.some((share) => share.incomplete) ? (
            <p className="text-xs text-muted-foreground">
              Some items are unpriced and provide no allocation weight.
            </p>
          ) : null}
        </Stack>
      ) : projectField ? (
        renderDetailFieldValue("expense", expense, projectField)
      ) : null}
    </Stack>
  );
}

export const expenseDetailFields = {
  "expense-spending-category": (expense) => ({
    value: categoryField
      ? renderDetailFieldValue("expense", expense, categoryField)
      : null,
  }),
  "expense-project": (expense) => ({
    value: <ExpenseProjectField expense={expense} />,
  }),
} satisfies EntityDetailFieldRenderers<"expense">;

type ExpenseOut = DetailRecordOf<"expense">;
