"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { entities } from "~/entities/entities";
import { type Entity } from "~/entities/types";

type EntityMutationCallbacks<TResult> = {
  onSuccess?: (result: TResult) => void;
  onError?: () => void;
};

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutationOptions: any,
  callbacks?: EntityMutationCallbacks<TResult>,
) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const mutation = useMutation<TResult, unknown, TData>({
    ...mutationOptions,
    onSuccess: (result: TResult) => {
      callbacks?.onSuccess?.(result);
      router.push(`/${entities[entityKey].basePath}/${result.id}`);
    },
    onError: (error: unknown) => {
      setError((error as Error).message);
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
    router.push(`/${entities[entityKey].basePath}`);
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mutationOptions: any,
  onCancel: () => void,
  callbacks?: EntityMutationCallbacks<TResult>,
) {
  const router = useRouter();
  const [error, setError] = useState<string | undefined>();

  const mutation = useMutation<TResult, unknown, TData>({
    ...mutationOptions,
    onSuccess: (result: TResult) => {
      callbacks?.onSuccess?.(result);
      router.refresh();
      onCancel();
    },
    onError: (error: unknown) => {
      setError((error as Error).message);
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
