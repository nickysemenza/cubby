import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ExpenseOut } from "@cubby/schemas/project";

import { useUpdateMutation } from "~/app/_components/hooks/useUpdateMutation";
import { ProjectSuggestionChips } from "~/app/expenses/project-suggestion-chips";
import { Stack } from "~/components/layout";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { renderDetailFieldValue } from "~/entities/entity-display";

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
      {projectField ? renderDetailFieldValue(expense, projectField) : null}
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
