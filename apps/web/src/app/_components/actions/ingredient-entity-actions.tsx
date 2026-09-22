import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { ingredient } from "~/app/ingredients/ingredient.functions";
import { showErrorToast } from "~/components/feedback/error-details";
import { entityMutationOptionsFactory } from "~/entities/entity-contracts";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import { useActionMutation } from "../hooks/useActionMutation";
import { EntityMergeDialog } from "../merge/entity-merge-dialog";
import { SetFieldDialog } from "../tracker/set-field-dialog";
import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

/**
 * Ingredient merge owns the staged rows and its confirmation dialog. Returning
 * `success: false` from `run` is intentional: opening the dialog must not
 * clear a person's selection before they confirm or cancel it.
 */
function useMergeIngredientsEntityAction(): EntityActionHandles {
  const [mergeRows, setMergeRows] = useState<readonly EntityActionRow[]>([]);
  const [mergePending, setMergePending] = useState(false);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );

  const finish = useCallback((success: boolean) => {
    setMergeRows([]);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);

  const run = useCallback((rows: readonly EntityActionRow[]) => {
    if (rows.length < 2) return Promise.resolve({ success: false });
    setMergeRows(rows);
    return new Promise<{ success: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  const confirmMerge = useCallback(
    async (keepId: string, aliasIds: string[]) => {
      const targetName =
        mergeRows.find((row) => row.id === keepId)?.name ?? "ingredient";
      setMergePending(true);
      try {
        const result = await ingredient.merge.call({
          keepId,
          mergeIds: aliasIds,
        });
        toast.success(
          savedWithBackgroundWork(
            result.sideEffects,
            `Merged into ${targetName} (${aliasIds.length} ingredient${aliasIds.length === 1 ? "" : "s"})`,
          ),
        );
        finish(true);
      } catch (err) {
        showErrorToast(err, "Merge failed");
      } finally {
        setMergePending(false);
      }
    },
    [finish, mergeRows],
  );

  return {
    run,
    rowMenuItem: () => null,
    dialog: (
      <EntityMergeDialog
        entity="ingredient"
        rows={[...mergeRows]}
        open={mergeRows.length > 0}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        onConfirm={confirmMerge}
        isPending={mergePending}
      />
    ),
  };
}

type IngredientActionRow = Omit<EntityActionRow, "name"> & {
  name: string;
  usuallyOnHand?: boolean;
};
const ingredientBulkUpdate = entityMutationOptionsFactory(
  "ingredient",
  "bulkUpdate",
);

function useSetUsuallyOnHandEntityAction(): EntityActionHandles {
  const [rows, setRows] = useState<IngredientActionRow[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );
  const finish = useCallback((success: boolean) => {
    setRows([]);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);
  const mutation = useActionMutation({
    mutationFn: ingredientBulkUpdate,
    success: (data) =>
      `Updated ${data.updated} ingredient${data.updated === 1 ? "" : "s"}`,
  });
  const run = useCallback((next: readonly EntityActionRow[]) => {
    setRows(next.map((row) => ({ ...row, name: row.name ?? row.id })));
    return new Promise<{ success: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  return {
    run,
    rowMenuItem: () => null,
    dialog: (
      <SetFieldDialog<IngredientActionRow>
        open={rows.length > 0}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        items={rows}
        isPending={mutation.isPending}
        options={[
          { value: "true", label: "Usually on hand" },
          { value: "false", label: "Not usually on hand" },
        ]}
        fieldLabel="Usually on hand"
        itemNoun="Ingredient"
        currentValue={(row) =>
          row.usuallyOnHand === undefined ? null : String(row.usuallyOnHand)
        }
        onConfirm={async (value) => {
          await mutation.mutateAsync({
            ids: rows.map((row) => row.id),
            data: { usuallyOnHand: value === "true" },
          });
          finish(true);
        }}
      />
    ),
  };
}

export const ingredientEntityActionDefinitions = [
  defineEntityAction({
    verb: "setUsuallyOnHand",
    entities: ["ingredient"],
    arity: "both",
    surfaces: ["selection"],
    group: "organize",
    priority: 90,
    preserveSelection: true,
    use: useSetUsuallyOnHandEntityAction,
  }),
  defineEntityAction({
    verb: "merge",
    entities: ["ingredient"],
    arity: "multi",
    surfaces: ["selection"],
    group: "organize",
    priority: 100,
    use: useMergeIngredientsEntityAction,
  }),
] as const;
