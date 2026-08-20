import { useCallback, useEffect, useState } from "react";
import type { EditableEntity } from "~/entities/editing";
import { useEntityCommands } from "~/entities/editing";
import { getErrorMessage } from "~/lib/error-utils";

/**
 * Mutation options from tRPC's .mutationOptions() call.
 * We use `object` since tRPC's options include complex error types and
 * function signatures that are difficult to type precisely. Type safety
 * is maintained at the call site via the generic TData/TResult parameters.
 */
type TRPCMutationOptions = object;

interface UseEditModeOptions<TResult = unknown> {
  entity: EditableEntity;
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
  entity,
  entityId,
  mutationOptions,
  onSuccess,
  useRouterRefresh: _useRouterRefresh = true,
  invalidateKeys: _invalidateKeys,
}: UseEditModeOptions<TResult>): UseEditModeReturn<TData> {
  const commands = useEntityCommands(entity);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // Compatibility inputs remain accepted while every detail form moves to an
  // intent-backed session. Canonical invalidation now comes from the registry.
  void mutationOptions;
  void _useRouterRefresh;
  void _invalidateKeys;

  // Reset edit state when navigating between entities of the same type.
  // entityId is intentionally the sole dependency — the effect exists to react to ID changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on entity change
  useEffect(() => {
    setIsEditing(false);
    setError(undefined);
  }, [entityId]);

  const handleEdit = useCallback(
    (data: TData) => {
      setError(undefined);
      const variables = data as {
        id?: string;
        data?: object;
      };
      void commands
        .executeOrThrow({
          entity,
          operation: "update",
          intent: "full",
          id: variables.id ?? entityId,
          data: variables.data ?? (data as object),
        })
        .then(({ result }) => {
          setIsEditing(false);
          setError(undefined);
          onSuccess?.(result as TResult);
        })
        .catch((cause: unknown) => {
          setError(getErrorMessage(cause));
        });
    },
    [commands, entity, entityId, onSuccess],
  );

  const startEditing = useCallback(() => {
    setIsEditing(true);
    setError(undefined);
  }, []);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setError(undefined);
  }, []);

  return {
    isEditing,
    error,
    isPending: commands.isPending,
    startEditing,
    handleEdit,
    handleCancel,
  };
}
