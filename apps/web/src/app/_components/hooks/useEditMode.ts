import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateTRPCQueries } from "~/lib/query-keys";

/**
 * Mutation options from tRPC's .mutationOptions() call.
 * We use `object` since tRPC's options include complex error types and
 * function signatures that are difficult to type precisely. Type safety
 * is maintained at the call site via the generic TData/TResult parameters.
 */
type TRPCMutationOptions = object;

interface UseEditModeOptions<TResult = unknown> {
  /** Entity ID — edit mode resets when this changes (e.g., navigating between detail pages). */
  entityId: string;
  mutationOptions: TRPCMutationOptions;
  onSuccess?: (result?: TResult) => void;
  useRouterRefresh?: boolean;
  /** Optional query keys to invalidate. If not provided, invalidates all queries. */
  invalidateKeys?: readonly (readonly unknown[])[];
}

export interface UseEditModeReturn<TData> {
  isEditing: boolean;
  error: string | undefined;
  isPending: boolean;
  startEditing: () => void;
  handleEdit: (data: TData) => void;
  handleCancel: () => void;
}

/**
 * Hook for managing edit mode state in detail pages.
 *
 * Handles:
 * - Edit mode toggle state
 * - Update mutation with success/error callbacks
 * - Router refresh on successful update
 * - Error state management
 */
export function useEditMode<TData, TResult = unknown>({
  entityId,
  mutationOptions,
  onSuccess,
  useRouterRefresh = true,
  invalidateKeys,
}: UseEditModeOptions<TResult>): UseEditModeReturn<TData> {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Reset edit state when navigating between entities of the same type.
  // entityId is intentionally the sole dependency — the effect exists to react to ID changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on entity change
  useEffect(() => {
    setIsEditing(false);
    setError(undefined);
  }, [entityId]);

  const mutation = useMutation<TResult, unknown, TData>({
    ...mutationOptions,
    onSuccess: (result: TResult) => {
      setIsEditing(false);
      setError(undefined);
      onSuccess?.(result);
      if (useRouterRefresh) {
        if (invalidateKeys && invalidateKeys.length > 0) {
          invalidateTRPCQueries(queryClient, invalidateKeys);
        } else {
          // Fall back to invalidating all queries
          queryClient.invalidateQueries();
        }
      }
    },
    onError: (error: unknown) => {
      setError(getErrorMessage(error));
    },
  });

  const startEditing = useCallback(() => {
    setIsEditing(true);
    setError(undefined);
  }, []);

  const handleEdit = useCallback(
    (data: TData) => {
      mutation.mutate(data);
    },
    [mutation],
  );

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setError(undefined);
  }, []);

  return {
    isEditing,
    error,
    isPending: mutation.isPending,
    startEditing,
    handleEdit,
    handleCancel,
  };
}
