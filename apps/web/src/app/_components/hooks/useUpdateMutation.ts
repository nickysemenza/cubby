import type { UseMutationOptions } from "@tanstack/react-query";

import { entityLabel } from "~/entities/entities";
import type { EntityMutationData } from "~/entities/entity-contracts";
import type {
  EntityMutationOptionsFactory,
  StandardEntity,
} from "~/entities/entity-contracts";
import { getErrorMessage } from "~/lib/error-utils";
import { savedWithBackgroundWork } from "~/lib/recompute-summary";

import {
  useActionMutation,
  useEntityActionMutation,
} from "./useActionMutation";

/** Entity-update convenience wrapper with the standard result-aware toast. */
export function useUpdateMutation<E extends StandardEntity>({
  mutationFn,
  entity,
}: {
  mutationFn: EntityMutationOptionsFactory<E, "update">;
  entity: E;
}) {
  const label = entityLabel(entity);
  return useEntityActionMutation({
    mutationFn,
    entity,
    operation: "update",
    intent: "full",
    successToastId: `entity-updated:${entity}`,
    success: (data: EntityMutationData<E, "update">) =>
      savedWithBackgroundWork(data.sideEffects, `${label} updated`),
    error: (error) =>
      getErrorMessage(error) || `Failed to update ${label.toLowerCase()}`,
  });
}

/** Image uses its specialized browser transport rather than entity editing. */
export function useImageUpdateMutation<TData, TVariables, TContext>({
  mutationFn,
}: {
  mutationFn: () => UseMutationOptions<TData, Error, TVariables, TContext>;
}) {
  const label = entityLabel("image");
  return useActionMutation({
    mutationFn,
    successToastId: "entity-updated:image",
    success: `${label} updated`,
    error: (error) =>
      getErrorMessage(error) || `Failed to update ${label.toLowerCase()}`,
  });
}
