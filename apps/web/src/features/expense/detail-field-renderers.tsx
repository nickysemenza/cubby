import { fieldDecisionOf, fieldValueOf } from "@cubby/schemas/field-envelope";
import { useQueryClient } from "@tanstack/react-query";

import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { renderDetailFieldValue } from "~/entity/display/entity-display";
import type { DetailRecordOf } from "~/entity/entity-detail/detail-record";
import { useEntityMetadata } from "~/entity/metadata";
import { ExpenseItemDetailReview } from "~/features/finance/spending-classification-review";
import { formatCurrency } from "~/lib/number-format";
import { Disclosure, Stack } from "~/ui/layout";
import { Description } from "~/ui/text/description";

import type { EntityDetailFieldRenderers } from "../../entity/display/detail-field-renderers/index";

/** Allocated projects retain their per-share amounts; proposals use the shared queue. */
function ExpenseProjectField({ expense }: { expense: ExpenseOut }) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata("expense");
  const projectField = metadata.fields.fields.find(
    (field) => field.key === "projectId",
  );
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
            <Description size="xs">
              Some items are unpriced and provide no allocation weight.
            </Description>
          ) : null}
        </Stack>
      ) : projectField ? (
        renderDetailFieldValue(queryClient, "expense", expense, projectField)
      ) : null}
    </Stack>
  );
}

function ExpenseCategoryField({ expense }: { expense: ExpenseOut }) {
  const queryClient = useQueryClient();
  const metadata = useEntityMetadata("expense");
  const categoryField = metadata.fields.fields.find(
    (field) => field.key === "spendingCategoryId",
  );
  if (!categoryField) return null;
  const saved = expense.fields.spendingCategoryId.current.assignment;
  const canUseDetail =
    saved?.kind === "value" &&
    saved.value !== null &&
    fieldValueOf(expense.fields.lineKind) === "principal";
  return (
    <Stack gap="xs">
      {renderDetailFieldValue(queryClient, "expense", expense, categoryField)}
      {canUseDetail && (
        <Disclosure summary="Use item detail">
          <Description>
            Review removing this line's saved spending category. Product,
            purchase and merchant rules will resolve it again; recorded money
            stays unchanged.
          </Description>
          <ExpenseItemDetailReview expenseIds={[expense.id]} />
        </Disclosure>
      )}
    </Stack>
  );
}

export const expenseDetailFields = {
  "expense-spending-category": (expense) => ({
    value: <ExpenseCategoryField expense={expense} />,
  }),
  "expense-project": (expense) => ({
    value: <ExpenseProjectField expense={expense} />,
  }),
} satisfies EntityDetailFieldRenderers<"expense">;

type ExpenseOut = DetailRecordOf<"expense">;
