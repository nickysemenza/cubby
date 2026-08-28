import { useCallback, useEffect, useState } from "react";

import { getErrorMessage } from "~/lib/error-utils";

import type { EntityEditResultFor } from "./intent-types";
import type { EditableEntity, EntityEditMutationData } from "./types";
import { useEntityCommands } from "./use-entity-commands";

export interface EntityDetailUpdateInput<E extends EditableEntity> {
  id?: string;
  data: EntityEditMutationData<E, "update">;
}

export interface EntityDetailController<TData> {
  isEditing: boolean;
  error: string | undefined;
  isPending: boolean;
  startEditing(): void;
  submit(data: TData): void;
  cancel(): void;
}

/** Detail-page lifecycle adapter. Rich forms keep their field layout, while
 * the final ordinary update crosses one semantic command seam. */
export function useEntityDetailController<
  E extends EditableEntity,
  TData extends EntityDetailUpdateInput<E>,
>({
  entity,
  entityId,
  onSuccess,
}: {
  entity: E;
  entityId: string;
  onSuccess?: (result: EntityEditResultFor<E>) => void;
}): EntityDetailController<TData> {
  const commands = useEntityCommands(entity);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setIsEditing(false);
    setError(undefined);
  }, [entityId]);

  const submit = useCallback(
    (data: TData) => {
      setError(undefined);
      void commands
        .submit({
          operation: "update",
          intent: "full",
          id: data.id ?? entityId,
          data: data.data,
        })
        .then((execution) => {
          if (execution.operation !== "update") {
            throw new Error(
              `${entity} update returned ${execution.operation}.`,
            );
          }
          setIsEditing(false);
          onSuccess?.(execution.result);
        })
        .catch((cause: unknown) => setError(getErrorMessage(cause)));
    },
    [commands, entity, entityId, onSuccess],
  );

  return {
    isEditing,
    error,
    isPending: commands.isPending,
    startEditing: () => {
      setError(undefined);
      setIsEditing(true);
    },
    submit,
    cancel: () => {
      setError(undefined);
      setIsEditing(false);
    },
  };
}
