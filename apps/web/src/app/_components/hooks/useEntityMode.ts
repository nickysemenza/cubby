import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { EditableEntity } from "~/entities/editing";
import { useEntityCommands } from "~/entities/editing";
import { entities, entityDetailLink } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";

type EntityMutationCallbacks<TResult> = {
  onSuccess?: (result: TResult) => void;
  onError?: () => void;
};

/**
 * Mutation options from tRPC's .mutationOptions() call.
 * We use `object` since tRPC's options include complex error types and
 * function signatures that are difficult to type precisely. Type safety
 * is maintained at the call site via the generic TData/TResult parameters.
 */
type TRPCMutationOptions = object;

/**
 * Hook for entity create mode that handles:
 * - Error state management
 * - Router navigation
 * - Mutation with success/error callbacks
 * - Navigation to entity detail on success
 * - Navigation to entity list on cancel
 */
export function useEntityCreateMode<
  TData,
  // Canonical public ids are the route keys for every entity created here.
  TResult extends { id: string },
>(
  entityKey: EditableEntity,
  mutationOptions: TRPCMutationOptions,
  callbacks?: EntityMutationCallbacks<TResult>,
) {
  const navigate = useNavigate();
  const commands = useEntityCommands(entityKey);
  const [error, setError] = useState<string | undefined>();

  // Kept as a compatibility type anchor while callers migrate; execution,
  // invalidation, and background-work refresh now belong to entity commands.
  void mutationOptions;

  const handleCreate = (data: TData) => {
    void handleCreateAsync(data).catch(() => undefined);
  };

  const handleCreateAsync = async (data: TData) => {
    setError(undefined);
    try {
      const execution = await commands.executeOrThrow({
        entity: entityKey,
        operation: "create",
        intent: "full",
        data: data as object,
      });
      const result = execution.result as TResult;
      callbacks?.onSuccess?.(result);
      await navigate(entityDetailLink(entityKey, result.id));
      return result;
    } catch (cause) {
      setError(getErrorMessage(cause));
      callbacks?.onError?.();
      throw cause;
    }
  };

  const handleCancel = () => {
    navigate({ to: `/${entities[entityKey].basePath}` });
  };

  return {
    error,
    isPending: commands.isPending,
    handleCreate,
    handleCreateAsync,
    handleCancel,
  };
}
