import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { recipe } from "~/app/recipes/recipe.functions";
import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { image } from "~/entities/image.functions";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { useActionMutation } from "../hooks/useActionMutation";
import { VerbMenuItem } from "./action-verb-ui";
import type {
  EntityActionDefinition,
  EntityActionHandles,
  EntityActionRow,
} from "./entity-actions";

type StagedDeleteRow = EntityActionRow & {
  recipeCount?: number;
};

function useStagedSpecialistDelete({
  entityLabel,
  description,
  pendingLabel,
  stageRow,
  renderItem,
  submit,
  isPending,
  failureMessage,
}: {
  entityLabel: string;
  description: string;
  pendingLabel: string;
  stageRow: (row: EntityActionRow) => StagedDeleteRow;
  renderItem: (row: StagedDeleteRow) => string;
  submit: (row: StagedDeleteRow) => Promise<unknown>;
  isPending: boolean;
  failureMessage: string;
}): EntityActionHandles {
  const [staged, setStaged] = useState<StagedDeleteRow | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );

  const finish = useCallback((success: boolean) => {
    setStaged(null);
    setFailure(null);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);

  const stage = useCallback(
    (rows: readonly EntityActionRow[]) => {
      const row = rows[0];
      if (!row) return Promise.resolve({ success: false });
      resolveRef.current?.({ success: false });
      setFailure(null);
      setStaged(stageRow(row));
      return new Promise<{ success: boolean }>((resolve) => {
        resolveRef.current = resolve;
      });
    },
    [stageRow],
  );

  return {
    run: stage,
    rowMenuItem: (row) => (
      <VerbMenuItem
        verb="delete"
        disabled={isPending}
        disabledReason={
          isPending
            ? `Deleting this ${entityLabel.toLowerCase()} is running.`
            : undefined
        }
        onSelect={(event) => {
          event.stopPropagation();
          void stage([row]);
        }}
      />
    ),
    availability: () =>
      isPending
        ? {
            status: "disabled",
            reason: `Deleting this ${entityLabel.toLowerCase()} is running.`,
          }
        : { status: "available" },
    dialog: staged ? (
      <BulkActionDialog
        open
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        items={[{ id: staged.id, name: staged.name ?? staged.id }]}
        itemNoun={entityLabel}
        action="Delete"
        variant="destructive"
        pendingLabel={pendingLabel}
        description={description}
        renderItem={() => renderItem(staged)}
        error={failure}
        onSubmit={async () => {
          try {
            await submit(staged);
            finish(true);
          } catch (error) {
            setFailure(getErrorMessage(error) || failureMessage);
          }
        }}
        isPending={isPending}
      />
    ) : null,
  };
}

/**
 * Cookbook deletion is intentionally unguarded: it soft-deletes every recipe
 * imported from the book, including recipes used as sub-recipes or planned
 * into meals. The staged promise keeps a list selection until confirmation.
 */
export function useDeleteCookbookEntityAction(): EntityActionHandles {
  const navigate = useNavigate();
  const mutation = useActionMutation({
    mutationFn: recipe.deleteCookbook.mutationOptions,
    success: ({ deletedRecipes }) =>
      `Deleted cookbook and ${deletedRecipes} recipe${deletedRecipes === 1 ? "" : "s"}`,
    error: (err) => getErrorMessage(err) || "Failed to delete cookbook",
  });
  const stageRow = useCallback((row: EntityActionRow): StagedDeleteRow => {
    return {
      ...row,
      name: row.name || row.book || "Untitled",
    };
  }, []);
  const submit = useCallback(
    async (row: StagedDeleteRow) => {
      await mutation.mutateAsync({
        cookbookId: parseShortcodeFor("cookbook", row.id),
      });
      void navigate({ to: "/cookbooks" });
    },
    [mutation.mutateAsync, navigate],
  );
  const action = useStagedSpecialistDelete({
    entityLabel: "Cookbook",
    description:
      "Deleting this cookbook also deletes every recipe it produced — including ones used as a sub-recipe elsewhere or currently planned into a meal, with no separate warning. This cannot be undone.",
    pendingLabel: "Deleting...",
    stageRow,
    renderItem: (row) =>
      row.recipeCount === undefined
        ? `"${row.name}" and its imported recipes`
        : `"${row.name}" and its ${row.recipeCount} imported recipe${row.recipeCount === 1 ? "" : "s"}`,
    submit,
    isPending: mutation.isPending,
    failureMessage: "Failed to delete cookbook",
  });
  return action;
}

/** Image deletion removes the database record and its R2 object together. */
export function useDeleteImageEntityAction(): EntityActionHandles {
  const navigate = useNavigate();
  const mutation = useActionMutation({
    mutationFn: image.delete.mutationOptions,
    success: ({ sideEffects }) =>
      savedWithBackgroundWork(sideEffects, "Image deleted"),
    error: (err) => getErrorMessage(err) || "Failed to delete image",
  });
  const stageRow = useCallback((row: EntityActionRow): StagedDeleteRow => {
    return {
      ...row,
      name: row.name || row.filename || "Image",
    };
  }, []);
  const submit = useCallback(
    async (row: StagedDeleteRow) => {
      await mutation.mutateAsync({
        ids: [parseShortcodeFor("image", row.id)],
      });
      void navigate({ to: "/images" });
    },
    [mutation.mutateAsync, navigate],
  );

  return useStagedSpecialistDelete({
    entityLabel: "Image",
    description:
      "This will permanently remove this image and its stored file from your workspace. This action cannot be undone.",
    pendingLabel: "Deleting...",
    stageRow,
    renderItem: (row) => row.name ?? row.id,
    submit,
    isPending: mutation.isPending,
    failureMessage: "Failed to delete image",
  });
}

export const specialistLifecycleEntityActionDefinitions = [
  {
    verb: "delete",
    entities: ["cookbook"],
    arity: "single",
    surfaces: ["row", "selection", "inspector", "detail"],
    group: "destructive",
    priority: 100,
    use: useDeleteCookbookEntityAction,
  },
  {
    verb: "delete",
    entities: ["image"],
    arity: "single",
    surfaces: ["inspector", "detail"],
    group: "destructive",
    priority: 100,
    use: useDeleteImageEntityAction,
  },
] as const satisfies readonly EntityActionDefinition[];
