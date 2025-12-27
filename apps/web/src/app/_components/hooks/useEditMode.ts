import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { getErrorMessage } from "~/lib/error-utils";

/**
 * Mutation options from tRPC's .mutationOptions() call.
 * We use `object` since tRPC's options include complex error types and
 * function signatures that are difficult to type precisely. Type safety
 * is maintained at the call site via the generic TData/TResult parameters.
 */
type TRPCMutationOptions = object;

interface UseEditModeOptions<TResult = unknown> {
  mutationOptions: TRPCMutationOptions;
  onSuccess?: (result?: TResult) => void;
  useRouterRefresh?: boolean;
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
 *
 * @example
 * ```tsx
 * const editMode = useEditMode({
 *   mutationOptions: api.product.update.mutationOptions(),
 *   useRouterRefresh: true,
 * });
 *
 * const sections: DetailSection[] = [
 *   {
 *     title: "Basic Information",
 *     content: editMode.isEditing ? (
 *       <EntityForm
 *         mode="edit"
 *         entity={product}
 *         onEdit={editMode.handleEdit}
 *         isPending={editMode.isPending}
 *         error={editMode.error}
 *         onCancel={editMode.handleCancel}
 *       />
 *     ) : (
 *       <div>
 *         {/* Display content *}
 *         <Button onClick={editMode.startEditing}>Edit</Button>
 *       </div>
 *     ),
 *   },
 * ];
 * ```
 */
export function useEditMode<TData, TResult = unknown>({
  mutationOptions,
  onSuccess,
  useRouterRefresh = true,
}: UseEditModeOptions<TResult>): UseEditModeReturn<TData> {
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const mutation = useMutation<TResult, unknown, TData>({
    ...mutationOptions,
    onSuccess: (result: TResult) => {
      setIsEditing(false);
      setError(undefined);
      onSuccess?.(result);
      if (useRouterRefresh) {
        queryClient.invalidateQueries();
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
