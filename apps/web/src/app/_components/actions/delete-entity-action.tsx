import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { entities, entityDialogLabel } from "~/entities/entities";
import type { GeneratedBrowserCrudEntity } from "~/entities/generated/entity-routes.gen";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import type { EntityActionHandles, EntityActionRow } from "./entity-actions";

const emptySideEffects: MutationSideEffects = { backgroundBatches: [] };

export function deleteDescriptionForEntity(
  entity: GeneratedBrowserCrudEntity,
  record: Pick<EntityActionRow, "name" | "subtaskCount"> = {},
): string {
  if (entity === "task") {
    const subtaskCount = record.subtaskCount ?? 0;
    return `${subtaskCount > 0 ? `This also deletes ${subtaskCount} subtask${subtaskCount === 1 ? "" : "s"}, and removes` : "This also removes"} the task from any dependency chains. This action cannot be undone.`;
  }
  const label = entityDialogLabel(entity).toLowerCase();
  return `This will permanently remove this ${label} from your workspace. This action cannot be undone.`;
}

/**
 * The shared destructive detail/inspector action for generated CRUD entities.
 * The dialog owns confirmation and refusal reporting; the command port owns
 * lifecycle guards, cache invalidation, and background-work side effects.
 */
export function useDeleteEntityAction(entity: Entity): EntityActionHandles {
  const generatedEntity = entity as GeneratedBrowserCrudEntity;
  const commands = useEntityCommands(generatedEntity);
  const navigate = useNavigate();
  const [staged, setStaged] = useState<EntityActionRow | null>(null);
  const [failures, setFailures] = useState<readonly string[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );
  const label = entityDialogLabel(generatedEntity);

  const finish = useCallback((success: boolean) => {
    setStaged(null);
    resolveRef.current?.({ success });
    resolveRef.current = null;
  }, []);

  const stage = useCallback((rows: readonly EntityActionRow[]) => {
    const row = rows[0];
    if (!row) return Promise.resolve({ success: false });
    resolveRef.current?.({ success: false });
    setFailures([]);
    setStaged(row);
    return new Promise<{ success: boolean }>((resolve) => {
      resolveRef.current = resolve;
    });
  }, []);

  return {
    run: stage,
    rowMenuItem: () => null,
    availability: () =>
      commands.isPending
        ? {
            status: "disabled",
            reason: `Deleting a ${label.toLowerCase()} is already running.`,
          }
        : { status: "available" },
    dialog: staged ? (
      <BulkActionDialog
        open
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
        items={[{ id: staged.id, name: staged.name ?? staged.id }]}
        itemNoun={label}
        action="Delete"
        variant="destructive"
        pendingLabel="Deleting..."
        description={deleteDescriptionForEntity(generatedEntity, staged)}
        renderItem={(item) => item.name}
        error={
          failures.length > 0 ? (
            <ul className="space-y-1">
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          ) : undefined
        }
        onSubmit={async () => {
          const execution = await commands.remove([staged.id]);
          if (!execution.ok) {
            setFailures(
              execution.issues.length > 0
                ? execution.issues.map((issue) => issue.message)
                : [`Failed to delete ${label}`],
            );
            return;
          }
          toast.success(
            savedWithBackgroundWork(
              (execution.result as { sideEffects?: MutationSideEffects })
                .sideEffects ?? emptySideEffects,
              `${label} deleted`,
            ),
          );
          finish(true);
          void navigate({ to: entities[generatedEntity].routes.list });
        }}
        isPending={commands.isPending}
      />
    ) : null,
  };
}

export const deleteEntityActionDefinition = {
  verb: "delete",
  entities: [
    "product",
    "recipe",
    "ingredient",
    "location",
    "inventory",
    "meal",
    "project",
    "task",
    "vendor",
    "purchase",
    "financialAccount",
    "financialTransaction",
    "wish",
    "expense",
  ] as const satisfies readonly GeneratedBrowserCrudEntity[],
  arity: "single",
  surfaces: ["inspector", "detail"],
  group: "destructive",
  priority: 100,
  use: useDeleteEntityAction,
} as const;
