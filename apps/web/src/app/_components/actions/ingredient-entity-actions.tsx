import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { ingredient } from "~/app/ingredients/ingredient.functions";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import { EntityMergeDialog } from "../merge/entity-merge-dialog";
import type {
  EntityActionDefinition,
  EntityActionHandles,
  EntityActionRow,
} from "./entity-actions";

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
        toast.error(`Merge failed: ${getErrorMessage(err)}`);
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

export const ingredientEntityActionDefinitions = [
  {
    verb: "merge",
    entities: ["ingredient"],
    arity: "multi",
    surfaces: ["selection"],
    group: "organize",
    priority: 100,
    use: useMergeIngredientsEntityAction,
  },
] as const satisfies readonly EntityActionDefinition[];
