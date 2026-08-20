import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { EditableEntity } from "~/entities/editing";
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

  const legacyMutation = useActionMutation({
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
      const entries = Object.entries(input.data);
      if (entries.length === 1) {
        const [field, value] = entries[0]!;
        const fieldResult = await commands.commitField({
          record: { id: input.id },
          field,
          value,
          intent: "full",
          surface: "cell",
        });
        if (fieldResult.ok) {
          return fieldResult.result as DataOf<TFn>;
        }
        const unknownField = fieldResult.issues.some((issue) =>
          issue.message.includes("does not expose"),
        );
        if (!unknownField) {
          throw new Error(fieldResult.issues[0]?.message ?? "Update failed");
        }
      }
      const execution = await commands.executeOrThrow({
        entity: commandEntity,
        operation: "update",
        intent: "legacy",
        id: input.id,
        data: input.data,
      });
      return execution.result as DataOf<TFn>;
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

  return registered ? registryMutation : legacyMutation;
}
