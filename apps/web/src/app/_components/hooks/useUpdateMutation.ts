import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EditableEntity, EntityEditDraft } from "~/entities/editing";
import { useEntityCommands } from "~/entities/editing";
import { entities } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import {
  type DataOf,
  type MutationOptionsFn,
  useActionMutation,
  type VariablesOf,
} from "./useActionMutation";

const emptySideEffects: MutationSideEffects = { backgroundBatches: [] };

/**
 * Update-mutation convenience wrapper over {@link useActionMutation}: fixes the
 * success toast to the `savedWithBackgroundWork(…, "{Entity} updated")` shape and
 * the error toast to a server-message-first "Failed to update {entity}". Pass a
 * tRPC `*.update.mutationOptions` reference; `TData`/`TVariables` are inferred.
 */
export function useUpdateMutation<TFn extends MutationOptionsFn>({
  mutationFn,
  entity,
  invalidateKeys,
}: {
  mutationFn: TFn;
  entity: Entity;
  invalidateKeys: readonly QueryKey[];
}) {
  const entityLabel = entities[entity].label;
  const registered =
    entity !== "image" && entity !== "usda-food" && entity !== "cookbook";
  const commandEntity = (registered ? entity : "product") as EditableEntity;
  const commands = useEntityCommands(commandEntity);

  const externalMutation = useActionMutation({
    mutationFn,
    invalidateKeys,
    // Collapse repeated "{Entity} updated" toasts (rapid inline edits, range
    // cell-paste fan-out) into one refreshing toast instead of a stack.
    successToastId: `entity-updated:${entity}`,
    success: (data) =>
      savedWithBackgroundWork(
        (data as { sideEffects?: MutationSideEffects }).sideEffects ??
          emptySideEffects,
        `${entityLabel} updated`,
      ),
    error: (err) =>
      getErrorMessage(err) || `Failed to update ${entityLabel.toLowerCase()}`,
  });

  const registryMutation = useMutation<DataOf<TFn>, Error, VariablesOf<TFn>>({
    mutationFn: async (variables) => {
      const input = variables as { id: string; data: object };
      const result = await commands.commitFields({
        record: { id: input.id },
        values: input.data as Partial<EntityEditDraft<typeof commandEntity>>,
        intent: "full",
        surface: "cell",
      });
      if (!result.ok) {
        throw new Error(result.issues[0]?.message ?? "Update failed");
      }
      return result.result as DataOf<TFn>;
    },
    onSuccess: (data) => {
      toast.success(
        savedWithBackgroundWork(
          (data as { sideEffects?: MutationSideEffects }).sideEffects ??
            emptySideEffects,
          `${entityLabel} updated`,
        ),
        { id: `entity-updated:${entity}` },
      );
    },
    onError: (error) => {
      toast.error(
        getErrorMessage(error) ||
          `Failed to update ${entityLabel.toLowerCase()}`,
      );
    },
  });

  return registered ? registryMutation : externalMutation;
}
