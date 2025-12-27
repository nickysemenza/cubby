import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { entities } from "~/entities/entities";
import type { Entity } from "~/entities/types";
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
export function useEntityCreateMode<TData, TResult extends { id: string }>(
  entityKey: Entity,
  mutationOptions: TRPCMutationOptions,
  callbacks?: EntityMutationCallbacks<TResult>,
) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | undefined>();

  const mutation = useMutation<TResult, unknown, TData>({
    ...mutationOptions,
    onSuccess: (result: TResult) => {
      callbacks?.onSuccess?.(result);
      navigate({ to: `/${entities[entityKey].basePath}/${result.id}` });
    },
    onError: (error: unknown) => {
      setError(getErrorMessage(error));
      callbacks?.onError?.();
    },
  });

  const handleCreate = (data: TData) => {
    mutation.mutate(data);
  };

  const handleCreateAsync = async (data: TData) => {
    return await mutation.mutateAsync(data);
  };

  const handleCancel = () => {
    navigate({ to: `/${entities[entityKey].basePath}` });
  };

  return {
    error,
    isPending: mutation.isPending,
    handleCreate,
    handleCreateAsync,
    handleCancel,
  };
}

/**
 * Hook for entity edit mode that handles:
 * - Error state management
 * - Router refresh
 * - Mutation with success/error callbacks
 * - Custom onCancel callback
 */
export function useEntityEditMode<TData, TResult>(
  mutationOptions: TRPCMutationOptions,
  onCancel: () => void,
  callbacks?: EntityMutationCallbacks<TResult>,
) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const mutation = useMutation<TResult, unknown, TData>({
    ...mutationOptions,
    onSuccess: (result: TResult) => {
      callbacks?.onSuccess?.(result);
      queryClient.invalidateQueries();
      onCancel();
    },
    onError: (error: unknown) => {
      setError(getErrorMessage(error));
      callbacks?.onError?.();
    },
  });

  const handleUpdate = (data: TData) => {
    mutation.mutate(data);
  };

  return {
    error,
    isPending: mutation.isPending,
    handleUpdate,
    handleCancel: onCancel,
  };
}
