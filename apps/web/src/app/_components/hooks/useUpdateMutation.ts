import type { UseMutationOptions } from "@tanstack/react-query";
import { useMemo } from "react";

import type { EntityMutationPort } from "~/entities/editing/types";
import { entityLabel } from "~/entities/entities";
import type { EntityMutationData } from "~/entities/entity-contracts";
import {
  entityMutationOptionsFactory,
  isGeneratedBrowserCrudEntity,
  type EntityMutationOptionsFactory,
  type StandardEntity,
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
  mutationPort,
}: {
  mutationFn: EntityMutationOptionsFactory<E, "update">;
  entity: E;
  /** Test seam: a local operation adapter in place of the Start transport. */
  mutationPort?: EntityMutationPort;
}) {
  const label = entityLabel(entity);
  return useEntityActionMutation({
    mutationFn,
    entity,
    operation: "update",
    mutationPort,
    intent: "full",
    successToastId: `entity-updated:${entity}`,
    success: (data: EntityMutationData<E, "update">) =>
      savedWithBackgroundWork(data.sideEffects, `${label} updated`),
    error: (error) =>
      getErrorMessage(error) || `Failed to update ${label.toLowerCase()}`,
  });
}

/** A generic column set's manifest-backed scalar write. */
export type EntityFieldSave = (
  row: { id: string },
  field: string,
  value: string | number | boolean | null,
) => Promise<void>;

/**
 * The `onSaveField` a generic list or embedded relation table hands
 * `createEntityDisplayColumns`, or `undefined` when `entity` has no standard
 * update command (cookbook, image) so those columns stay read-only. The hook
 * count is constant: a non-CRUD entity binds the mutation to `"product"` and
 * never invokes it.
 */
export function useEntityFieldSave(
  entity: string,
  options?: { mutationPort?: EntityMutationPort },
): EntityFieldSave | undefined {
  const standard = isGeneratedBrowserCrudEntity(entity);
  const mutationEntity: StandardEntity = standard ? entity : "product";
  const update = useUpdateMutation({
    mutationFn: entityMutationOptionsFactory(mutationEntity, "update"),
    entity: mutationEntity,
    mutationPort: options?.mutationPort,
  });
  return useMemo(
    () =>
      standard
        ? async (row, field, value) => {
            await update.mutateAsync({ id: row.id, data: { [field]: value } });
          }
        : undefined,
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mutation result objects change every render; mutateAsync is the stable operation port.
    [standard, update.mutateAsync],
  );
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
