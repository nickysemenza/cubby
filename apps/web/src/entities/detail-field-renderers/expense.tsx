import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ExpenseOut } from "@cubby/schemas/project";

import { EntityInlineLink } from "~/app/_components/EntityInlineLink";
import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ProjectSuggestionChips } from "~/app/expenses/project-suggestion-chips";
import { Stack } from "~/components/layout";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { renderDetailFieldValue } from "~/entities/entity-display";
import { formatCurrency } from "~/lib/utils";

import type { EntityDetailFieldRenderers } from "./index";

const projectField = entityFieldModels.expense.fields.find(
  (field) => field.key === "projectId",
);

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
                <EntityInlineLink
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
      ) : projectField ? (
        renderDetailFieldValue("expense", expense, projectField)
      ) : null}
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
  "expense-project": (expense) => ({
    value: <ExpenseProjectField expense={expense} />,
  }),
} satisfies EntityDetailFieldRenderers<"expense">;
