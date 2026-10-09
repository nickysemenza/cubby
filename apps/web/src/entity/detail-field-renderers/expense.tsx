import type { ExpenseOut } from "@cubby/schemas/project";

import { ProjectSuggestionChips } from "~/app/expenses/project-suggestion-chips";
import { EntityRefLink } from "~/entity/components/entity-ref-link";
import { entityMutationOptionsFactory } from "~/entity/entity-contracts";
import { renderDetailFieldValue } from "~/entity/entity-display";
import { entityFieldModel } from "~/entity/entity-model";
import { formatCurrency } from "~/lib/utils";
import { useUpdateMutation } from "~/ui/hooks/useUpdateMutation";
import { Stack } from "~/ui/layout";

import type { EntityDetailFieldRenderers } from "./index";

// Read on render: the expense model registers with the route, after import.
const expenseField = (key: "spendingCategoryId" | "projectId") =>
  entityFieldModel("expense").fields.find((field) => field.key === key);

function renderExpenseField(
  expense: ExpenseOut,
  key: "spendingCategoryId" | "projectId",
) {
  const field = expenseField(key);
  return field ? renderDetailFieldValue("expense", expense, field) : null;
}

/**
 * The project link plus the relationship-discovery suggestions for it: an
 * unassigned or doubtfully assigned line offers the projects its siblings
 * and vendor point at, applied with one click.
 */
function ExpenseProjectField({ expense }: { expense: ExpenseOut }) {
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory("expense", "update"),
    entity: "expense",
  });
  return (
    <Stack gap="xs">
      {expense.lineKind !== "principal" ? (
        <Stack gap="xs">
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
                  displayImage={null}
                  truncate
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
      ) : (
        renderExpenseField(expense, "projectId")
      )}
      {expense.lineKind === "principal" ? (
        <ProjectSuggestionChips
          expense={expense}
          isPending={update.isPending}
          onAssign={async (projectId) => {
            await update.mutateAsync({ id: expense.id, data: { projectId } });
          }}
        />
      ) : null}
    </Stack>
  );
}

export const expenseDetailFields = {
  "expense-spending-category": (expense) => ({
    value: renderExpenseField(expense, "spendingCategoryId"),
  }),
  "expense-project": (expense) => ({
    value: <ExpenseProjectField expense={expense} />,
  }),
} satisfies EntityDetailFieldRenderers<"expense">;
