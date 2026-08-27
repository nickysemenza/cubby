import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EditableEntity } from "~/entities/editing/types";
import { useEntityCommands } from "~/entities/editing/use-entity-commands";
import { entityLabel } from "~/entities/entities";
import type { GeneratedBrowserCrudEntity } from "~/entities/generated/entity-routes.gen";
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
 * mutation-options factory; `TData`/`TVariables` are inferred.
 */
export function useUpdateMutation<TFn extends MutationOptionsFn>({
  mutationFn,
  entity,
}: {
  mutationFn: TFn;
  entity: GeneratedBrowserCrudEntity | "image";
}) {
  const label = entityLabel(entity);
  const registered = entity !== "image";
  const commandEntity = (registered ? entity : "product") as EditableEntity;
  const commands = useEntityCommands(commandEntity);

  const externalMutation = useActionMutation({
    mutationFn,
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
      const result = await commands.commitRuntimeFields({
        record: { id: input.id },
        values: input.data,
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
