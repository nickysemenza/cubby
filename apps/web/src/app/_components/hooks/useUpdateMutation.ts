import type { MutationSideEffects } from "@cubby/schemas/background-jobs";
import type { Entity } from "@cubby/schemas/entity";
import type { QueryKey } from "@tanstack/react-query";
import { entities } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";
import { type MutationOptionsFn, useActionMutation } from "./useActionMutation";

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

  return useActionMutation({
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
}
