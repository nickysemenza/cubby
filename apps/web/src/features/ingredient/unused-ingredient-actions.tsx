import { countLabel } from "@cubby/shared/pluralize";

import { useActionMutation } from "~/entity/hooks/use-action-mutation";
import {
  WorkActionLink,
  WorkActionTrigger,
  type WorkActionProps,
} from "~/entity/work-queue/work-actions";
import { problems } from "~/integrations/tanstack-query/generated/catalog/problems.gen";

type UnusedProblem =
  | "unusedIngredientsWithProduct"
  | "unusedIngredientsWithoutProduct";

/**
 * Delete an unused Ingredient (`item`), or every one the Problem lists
 * (`group`). A group delete names the Problem, never the loaded rows: the
 * server re-runs the Problem's own filters to resolve the set. The endpoint
 * reports per-ingredient failures (a product still has inventory) instead of
 * throwing, so the toast reflects the outcome.
 */
function UnusedIngredientDelete({
  problemKey,
  alsoDeleteProducts,
  ...props
}: WorkActionProps & {
  problemKey: UnusedProblem;
  alsoDeleteProducts: boolean;
}) {
  const remove = useActionMutation({
    mutationFn: problems.deleteUnused.mutationOptions,
    success: (data) =>
      data.failed.length > 0
        ? `Deleted ${data.deleted}, ${data.failed.length} failed (e.g. ${data.failed[0]?.reason ?? "unknown"})`
        : `Deleted ${countLabel(data.deleted, "ingredient")}`,
  });
  const { target } = props;
  return (
    <WorkActionTrigger
      {...props}
      pending={remove.isPending}
      onRun={() =>
        remove.mutate(
          target.scope === "group"
            ? { allFromProblem: problemKey, alsoDeleteProducts }
            : {
                ingredientIds: target.row.id ? [target.row.id] : [],
                alsoDeleteProducts,
              },
        )
      }
    />
  );
}

export const UnusedWithProductDeleteAction = (props: WorkActionProps) => (
  <UnusedIngredientDelete
    {...props}
    problemKey="unusedIngredientsWithProduct"
    alsoDeleteProducts
  />
);

export const UnusedWithoutProductDeleteAction = (props: WorkActionProps) => (
  <UnusedIngredientDelete
    {...props}
    problemKey="unusedIngredientsWithoutProduct"
    alsoDeleteProducts={false}
  />
);

/** `ingredientsWithoutProduct:open-workbench`: the workbench can create the
 * Product; the detail page can't. */
export function IngredientWorkbenchAction(props: WorkActionProps) {
  const id = props.target.scope === "item" ? props.target.row.id : null;
  return (
    <WorkActionLink
      action={props.action}
      href={`/ingredients/workbench${id ? `?focus=${id}` : ""}`}
    />
  );
}
