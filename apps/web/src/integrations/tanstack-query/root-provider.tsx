import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack";
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Link as TanStackLink, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { authClient } from "~/lib/auth-client";
import {
  makeBatchStatusFetcher,
  watchBatchesAndInvalidateTags,
} from "~/lib/background-batch-polling";
import { getErrorMessage } from "~/lib/error-utils";
import {
  invalidateOperationTags,
  resolveInvalidationTags,
} from "./operation-cache";
import { operationInvalidationTags } from "./operation-catalog";
import { installOperationRecorder } from "./operation-recorder";
import { persister } from "./persister";
import { shouldToastQueryError } from "./query-error-policy";

// Wrapper to adapt TanStack Router Link to better-auth-ui Link format
const Link = ({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) => (
  <TanStackLink to={href} className={className}>
    {children}
  </TanStackLink>
);

// React Query fires these cache error callbacks from inside its notify cycle,
// which can land during React's render/commit phase (e.g. a background query
// rejecting while a route is still mounting). Calling sonner's toast() there
// updates the <Toaster> store mid-mount and triggers React's "Can't perform a
// state update on a component that hasn't mounted yet" warning. Deferring to a
// macrotask guarantees the toast fires after the current commit.
function deferToastError(error: unknown) {
  setTimeout(() => toast.error(getErrorMessage(error)), 0);
}

export function getContext() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        retry: false,
      },
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
      onError: (error) => {
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
            : (operationInvalidationTags(mutation.meta?.operation, variables) ??
              []);
        if (invalidations.length === 0) return;
        void invalidateOperationTags(queryClient, invalidations);
        void watchBatchesAndInvalidateTags({
          queryClient,
          result: data,
          invalidateTags: invalidations,
          fetchBatchStatus: makeBatchStatusFetcher(queryClient),
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
  const navigate = useNavigate();

  return (
    <AuthQueryProvider>
      <AuthUIProviderTanstack
        authClient={authClient}
        navigate={(href) => navigate({ to: href })}
        replace={(href) => navigate({ to: href, replace: true })}
        Link={Link}
        passkey
        signUp={false}
        toast={({ variant, message }) => {
          const text = message ?? "Something went wrong.";
          if (variant === "error") toast.error(text);
          else if (variant === "success") toast.success(text);
          else if (variant === "warning") toast.warning(text);
          else if (variant === "info") toast.info(text);
          else toast(text);
        }}
      >
        {persister ? (
          <PersistQueryClientProvider
            client={queryClient}
            persistOptions={{
              persister,
              // Bust the persisted cache whenever the deploy changes, so a
              // schema/shape change can't resurrect stale offline data.
              buster: __GIT_COMMIT__,
              maxAge: 1000 * 60 * 60 * 24,
              dehydrateOptions: {
                shouldDehydrateQuery: (query) => {
                  return (
                    query.meta?.persistence === "persist" &&
                    query.state.status === "success"
                  );
                },
              },
            }}
          >
            {children}
          </PersistQueryClientProvider>
        ) : (
          children
        )}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
