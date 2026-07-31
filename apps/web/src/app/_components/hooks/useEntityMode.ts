import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { entities, entityDetailLink } from "~/entities/entities";
import { getErrorMessage } from "~/lib/error-utils";
import { invalidateTRPCQueries, queryKeys } from "~/lib/query-keys";

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
  entityKey: ShortcodeEntity,
  mutationOptions: TRPCMutationOptions,
  callbacks?: EntityMutationCallbacks<TResult>,
) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | undefined>();

  const mutation = useMutation<TResult, unknown, TData>({
    ...mutationOptions,
    onSuccess: (result: TResult) => {
      // Invalidate the list query for this entity type so it refetches with the new item
      // Narrow with "in" — non-entity groups in queryKeys (e.g. debug) have no list key
      const entityQueryKeys = queryKeys[entityKey as keyof typeof queryKeys];
      const listKey =
        entityQueryKeys && "list" in entityQueryKeys
          ? entityQueryKeys.list
          : undefined;
      if (listKey) {
        invalidateTRPCQueries(queryClient, [listKey]);
      }

      callbacks?.onSuccess?.(result);
      navigate(entityDetailLink(entityKey, result.id));
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
