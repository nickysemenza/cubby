import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EntityEditDraft } from "~/entities/editing/intent-types";
import type { EditableEntity } from "~/entities/editing/types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { entityLabel } from "~/entities/entities";
import type { GeneratedBrowserCrudEntity } from "~/entities/generated/entity-routes.gen";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidatesFor } from "~/lib/query-keys";
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
 * mutation-options factory; `TData`/`TVariables` are inferred.
 */
export function useUpdateMutation<TFn extends MutationOptionsFn>({
  mutationFn,
  entity,
  invalidateKeys,
}: {
  mutationFn: TFn;
  entity: GeneratedBrowserCrudEntity | "image";
  /**
   * Override the fan-out. Omit it — the default is the entity's own
   * `invalidatesFor(entity)` set, which is what an ordinary update wants. Pass
   * one only for a write that moves MORE than
   * the entity's own rows (a valuation edit, a link that both ends read).
   */
  invalidateKeys?: readonly QueryKey[];
}) {
  const label = entityLabel(entity);
  const keys = invalidateKeys ?? invalidatesFor(entity);
  const registered = entity !== "image";
  const commandEntity = (registered ? entity : "product") as EditableEntity;
  const commands = useEntityCommands(commandEntity);

  const externalMutation = useActionMutation({
    mutationFn,
    invalidateKeys: keys,
    // Collapse repeated "{Entity} updated" toasts (rapid inline edits, range
    // cell-paste fan-out) into one refreshing toast instead of a stack.
    successToastId: `entity-updated:${entity}`,
    success: (data) =>
      savedWithBackgroundWork(
        (data as { sideEffects?: MutationSideEffects }).sideEffects ??
          emptySideEffects,
        `${label} updated`,
      ),
    error: (err) =>
      getErrorMessage(err) || `Failed to update ${label.toLowerCase()}`,
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
          `${label} updated`,
        ),
        { id: `entity-updated:${entity}` },
      );
    },
    onError: (error) => {
      toast.error(
        getErrorMessage(error) || `Failed to update ${label.toLowerCase()}`,
      );
    },
  });

  return registered ? registryMutation : externalMutation;
}
