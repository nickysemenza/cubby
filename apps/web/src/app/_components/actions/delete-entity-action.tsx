import type { Entity } from "@cubby/schemas/entity";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { BulkActionDialog } from "~/components/dialogs/bulk-action-dialog";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import type { EntityCommands } from "~/entities/editing/use-entity-commands";
import { entities, entityLabel } from "~/entities/entities";
import {
  generatedBrowserCrudEntities,
  type GeneratedBrowserCrudEntity,
} from "~/entities/generated/entity-routes.gen";

import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles, EntityActionRow } from "./entity-actions";
import {
  DeleteImpactPreview,
  type ImpactPreviewOperations,
} from "./entity-operation-impact-preview";

/** The delete dialog depends on this small command surface, not the form kernel. */
export type DeleteEntityActionCommands = Pick<
  EntityCommands<GeneratedBrowserCrudEntity>,
  "isPending" | "remove"
>;

export function deleteDescriptionForEntity(
  entity: GeneratedBrowserCrudEntity,
): string {
  const label = entityLabel(entity).toLowerCase();
  return `This will permanently remove this ${label} from your workspace. This action cannot be undone.`;
}

/**
 * The shared destructive detail/inspector action for generated CRUD entities.
 * The dialog owns confirmation and refusal reporting; the command port owns
 * lifecycle guards, cache invalidation, and background-work side effects.
 */
export function useDeleteEntityAction(
  entity: Entity,
  commandOverride?: DeleteEntityActionCommands,
  options?: {
    /**
     * Skip the after-delete `navigate` to the entity's list route. Default
     * `true` suits a "detail"/"inspector" surface — the row deleted IS the
     * page (or the page's list) the caller is already on. A board/agenda
     * surface that can be embedded inside another entity's own detail page
     * (e.g. `TaskBoard` inside `ProjectDetail`) passes `false` so deleting a
     * row there doesn't navigate the household away from that page.
     */
    navigateOnSuccess?: boolean;
    /** Test-injectable seam for the impact preview's `connections` query. */
    impactPreviewOperations?: ImpactPreviewOperations;
  },
): EntityActionHandles {
  // SAFETY: this action definition is registered only for generated CRUD entities.
  const generatedEntity = entity as GeneratedBrowserCrudEntity;
  const generatedCommands = useEntityCommands(generatedEntity);
  const commands = commandOverride ?? generatedCommands;
  const navigate = useNavigate();
  const [staged, setStaged] = useState<EntityActionRow | null>(null);
  const [failures, setFailures] = useState<readonly string[]>([]);
  const resolveRef = useRef<((result: { success: boolean }) => void) | null>(
    null,
  );
  const label = entityLabel(generatedEntity);

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
        description={deleteDescriptionForEntity(generatedEntity)}
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
          // `useEntityCommands` owns cache invalidation and background-work
          // revalidation; its public delete result intentionally exposes no
          // transport payload for this action to inspect.
          toast.success(`${label} deleted`);
          finish(true);
          if (options?.navigateOnSuccess ?? true)
            void navigate({ to: entities[generatedEntity].routes.list });
        }}
        isPending={commands.isPending}
      >
        <DeleteImpactPreview
          id={staged.id}
          operations={options?.impactPreviewOperations}
        />
      </BulkActionDialog>
    ) : null,
  };
}

export const deleteEntityActionDefinition = defineEntityAction({
  verb: "delete",
  entities: generatedBrowserCrudEntities,
  arity: "single",
  surfaces: ["inspector", "detail"],
  group: "destructive",
  priority: 100,
  use: useDeleteEntityAction,
});
