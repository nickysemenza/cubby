import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "~/lib/error-utils";
import type { EditableEntity } from "./types";
import { useEntityCommands } from "./use-entity-commands";

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
export function useEntityDetailController<TData, TResult = unknown>({
  entity,
  entityId,
  onSuccess,
}: {
  entity: EditableEntity;
  entityId: string;
  onSuccess?: (result?: TResult) => void;
}): EntityDetailController<TData> {
  const commands = useEntityCommands(entity);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a record identity change deliberately exits edit mode
  useEffect(() => {
    setIsEditing(false);
    setError(undefined);
  }, [entityId]);

  const submit = useCallback(
    (data: TData) => {
      const variables = data as { id?: string; data?: object };
      setError(undefined);
      void commands
        .submit({
          operation: "update",
          intent: "full",
          id: variables.id ?? entityId,
          data: variables.data ?? (data as object),
        })
        .then(({ result }) => {
          setIsEditing(false);
          onSuccess?.(result as TResult);
        })
        .catch((cause: unknown) => setError(getErrorMessage(cause)));
    },
    [commands, entityId, onSuccess],
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
