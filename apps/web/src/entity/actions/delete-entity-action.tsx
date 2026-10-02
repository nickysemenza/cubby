import type { Entity } from "@cubby/schemas/entity";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { useEntityCommands } from "~/entity/editing/use-entity-commands";
import type { EntityCommands } from "~/entity/editing/use-entity-commands";
import { entities, entityLabel } from "~/entity/entities";
import {
  generatedBrowserCrudEntities,
  type GeneratedBrowserCrudEntity,
} from "~/entity/generated/entity-routes.gen";
import { pluralWord } from "~/lib/pluralize";
import { BulkActionDialog } from "~/ui/dialogs/bulk-action-dialog";

import { defineEntityAction } from "./entity-action-definition";
import type { EntityActionHandles } from "./entity-actions";
import {
  DeleteImpactPreviewList,
  type ImpactPreviewOperations,
} from "./entity-operation-impact-preview";
import { useStagedRow } from "./use-staged-row";

/** The delete dialog depends on this small command surface, not the form kernel. */
export type DeleteEntityActionCommands = Pick<
  EntityCommands<GeneratedBrowserCrudEntity>,
  "isPending" | "remove"
>;

/** One confirmation sentence for a delete of `count` rows of `label`. */
function deleteDescription(label: string, count = 1): string {
  const noun = label.toLowerCase();
  const subject =
    count === 1 ? `this ${noun}` : `${count} ${pluralWord(noun, count)}`;
  return `This will permanently remove ${subject} from your workspace. This action cannot be undone.`;
}

export function deleteDescriptionForEntity(
  entity: GeneratedBrowserCrudEntity,
): string {
  return deleteDescription(entityLabel(entity));
}

/**
 * The one delete confirmation: the rows about to go, the refusal list, and the
 * advisory connection-impact preview. The detail/inspector action and the
 * list/selection delete both render this, so a delete reads the same wherever
 * it starts. `previewImpact` is off only for a delete with no connections
 * graph (the legacy image delete).
 */
export function DeleteEntityDialog({
  entityLabel: label,
  items,
  failures = [],
  isPending,
  previewImpact = true,
  description,
  renderItem = (item) => item.name,
  impactPreviewOperations,
  onOpenChange,
  onSubmit,
}: {
  entityLabel: string;
  items: readonly { id: string; name: string }[];
  failures?: readonly string[];
  isPending: boolean;
  previewImpact?: boolean;
  /** Overrides the generic confirmation sentence (cascading deletes). */
  description?: string;
  renderItem?: (item: { id: string; name: string }) => string;
  /** Test-injectable seam for the impact preview's `connections` query. */
  impactPreviewOperations?: ImpactPreviewOperations;
  onOpenChange: (open: boolean) => void;
  onSubmit: () => Promise<void>;
}) {
  return (
    <BulkActionDialog
      open={items.length > 0}
      onOpenChange={onOpenChange}
      items={[...items]}
      itemNoun={label}
      action="Delete"
      variant="destructive"
      pendingLabel="Deleting..."
      description={description ?? deleteDescription(label, items.length)}
      renderItem={renderItem}
      error={
        failures.length > 0 ? (
          <ul className="space-y-1">
            {failures.map((failure) => (
              <li key={failure}>{failure}</li>
            ))}
          </ul>
        ) : undefined
      }
      onSubmit={onSubmit}
      isPending={isPending}
    >
      {previewImpact ? (
        <DeleteImpactPreviewList
          targets={items.map((item) => ({ id: item.id, label: item.name }))}
          operations={impactPreviewOperations}
        />
      ) : null}
    </BulkActionDialog>
  );
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
  const [failures, setFailures] = useState<readonly string[]>([]);
  const label = entityLabel(generatedEntity);
  const { staged, stage, finish } = useStagedRow(
    (row) => row,
    () => setFailures([]),
  );

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
      <DeleteEntityDialog
        entityLabel={label}
        items={[{ id: staged.id, name: staged.name ?? staged.id }]}
        failures={failures}
        isPending={commands.isPending}
        impactPreviewOperations={options?.impactPreviewOperations}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
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
      />
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
