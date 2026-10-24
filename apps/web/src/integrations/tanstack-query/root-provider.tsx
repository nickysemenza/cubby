import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import superjson from "superjson";
import { z } from "zod";

import { EntityDisplayImagesProvider } from "~/entity/entity-media/entity-display-images";
import { showErrorToast } from "~/ui/feedback/error-details";

import {
  EMPTY_INVALIDATION_TAG_SET,
  type InvalidationTagSet,
} from "./cache-tags";
import {
  invalidateOperationTags,
  resolveInvalidationTags,
} from "./operation-cache";
import { cancelQueriesByTags } from "./operation-cache";
import { operationInvalidationTags } from "./operation-catalog";
import { installOperationRecorder } from "./operation-recorder";
import {
  shouldToastMutationError,
  shouldToastQueryError,
} from "./query-error-policy";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "./query-policy";
import {
  mutationReceipt,
  reconcileMutationReceipt,
} from "./receipt-reconciliation";

// React Query fires these cache error callbacks from inside its notify cycle,
// which can land during React's render/commit phase (e.g. a background query
// rejecting while a route is still mounting). Calling sonner's toast() there
// updates the <Toaster> store mid-mount and triggers React's "Can't perform a
// state update on a component that hasn't mounted yet" warning. Deferring to a
// macrotask guarantees the toast fires after the current commit.
function deferToastError<Failure>(error: Failure) {
  setTimeout(() => showErrorToast(error), 0);
}

const writeTargets = z.object({
  id: z.string().optional(),
  ids: z.array(z.string()).optional(),
});

export interface RootMutationSuccessRuntime {
  registeredInvalidations<Variables>(
    operation: string | undefined,
    variables: Variables,
  ): InvalidationTagSet;
  afterSuccess<Result>(options: {
    queryClient: QueryClient;
    result: Result;
    invalidations: InvalidationTagSet;
  }): void | Promise<void>;
}

const productionMutationSuccessRuntime: RootMutationSuccessRuntime = {
  registeredInvalidations: (operation, variables) =>
    operationInvalidationTags(operation, variables) ??
    EMPTY_INVALIDATION_TAG_SET,
  afterSuccess: async ({ queryClient, result, invalidations }) => {
    // Retire reads begun before the receipt before publishing confirmed values.
    await cancelQueriesByTags(queryClient, invalidations);
    reconcileMutationReceipt(queryClient, mutationReceipt(result));
    void invalidateOperationTags(queryClient, invalidations, {
      removeInactive: true,
    });
  },
};

export function getContext(
  mutationSuccessRuntime: RootMutationSuccessRuntime = productionMutationSuccessRuntime,
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      ...QUERY_CLIENT_DEFAULT_OPTIONS,
      dehydrate: { serializeData: superjson.serialize },
      hydrate: { deserializeData: superjson.deserialize },
    },
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (!shouldToastQueryError(error, query)) return;
        deferToastError(error);
      },
    }),
    mutationCache: new MutationCache({
      onMutate: (variables, current) => {
        if (typeof navigator !== "undefined" && navigator.onLine === false)
          throw new Error(
            "Cannot save while offline. Reconnect and submit again.",
          );
        if (current.options.meta?.operation !== "entity.mutate") return;
        const targets = writeTargets.safeParse(variables);
        if (!targets.success) return;
        const ids = new Set(
          targets.data.ids ?? (targets.data.id ? [targets.data.id] : []),
        );
        if (!ids.size) return;
        const conflict = queryClient
          .getMutationCache()
          .getAll()
          .some((other) => {
            if (
              other.mutationId >= current.mutationId ||
              other.state.status !== "pending" ||
              other.options.meta?.operation !== "entity.mutate" ||
              other.options.meta.entity !== current.options.meta?.entity
            )
              return false;
            const parsed = writeTargets.safeParse(other.state.variables);
            return (
              parsed.success &&
              (
                parsed.data.ids ?? (parsed.data.id ? [parsed.data.id] : [])
              ).some((id) => ids.has(id))
            );
          });
        if (conflict)
          throw new Error(
            "This record is already saving. Wait for that save to finish.",
          );
      },
      onError: (error, _variables, _onMutateResult, mutation) => {
        if (!shouldToastMutationError(mutation)) return;
        deferToastError(error);
      },
      onSuccess: (data, variables, _onMutateResult, mutation) => {
        // `meta.invalidates` wins whenever it says anything. The registered
        // policy is keyed on the operation id and reads the OPERATION's input,
        // but a mutation can be hung on a descriptor whose `variables` are the
        // call site's own shape — `entityMutationOptionsFactory` passes
        // `{ id, data }` to an `entity.mutate` policy that expects a command
        // envelope. The descriptor-owned tag list on `meta` is the one that
        // knows the entity in that case. Behaviour-preserving for every
        // pre-existing descriptor: a static `invalidates:` already puts the
        // policy's exact output on `meta`, and a dynamic one leaves it empty.
        const declared = resolveInvalidationTags(mutation.meta?.invalidates);
        const invalidations =
          declared.length > 0
            ? declared
            : mutationSuccessRuntime.registeredInvalidations(
                mutation.meta?.operation,
                variables,
              );
        if (invalidations.length === 0) return;
        return mutationSuccessRuntime.afterSuccess({
          queryClient,
          result: data,
          invalidations,
        });
      },
    }),
  });
  if (!import.meta.env.SSR) installOperationRecorder(queryClient);
  return { queryClient };
}

export function Provider({
  children,
  queryClient,
}: {
  children: React.ReactNode;
  queryClient: QueryClient;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <EntityDisplayImagesProvider refs={[]} collectMountedRefs>
        {children}
      </EntityDisplayImagesProvider>
    </QueryClientProvider>
  );
}
