import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack";
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack";
import {
  MutationCache,
  QueryCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { Link as TanStackLink, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { z } from "zod";

import { authClient } from "~/lib/auth-client";
import { scheduleDeferredInvalidation } from "~/lib/deferred-invalidation";
import { getErrorMessage } from "~/lib/error-utils";
import { GMAIL_READONLY_SCOPE } from "~/lib/google-auth-constants";

import {
  EMPTY_INVALIDATION_TAG_SET,
  type InvalidationTagSet,
} from "./cache-tags";
import {
  invalidateOperationTags,
  resolveInvalidationTags,
} from "./operation-cache";
import { operationInvalidationTags } from "./operation-catalog";
import { installOperationRecorder } from "./operation-recorder";
import {
  shouldToastMutationError,
  shouldToastQueryError,
} from "./query-error-policy";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "./query-policy";

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

const googleSignInParams = z.object({
  provider: z.literal("google"),
  callbackURL: z.string().optional(),
});

const signInWithGoogle = (params: unknown) => {
  const parsed = googleSignInParams.parse(params);
  return authClient.signIn.social({
    provider: "google",
    callbackURL: parsed.callbackURL,
    errorCallbackURL: "/auth/sign-in?google_error=true",
    fetchOptions: { throw: true },
    requestSignUp: false,
    scopes: [GMAIL_READONLY_SCOPE],
  });
};

// React Query fires these cache error callbacks from inside its notify cycle,
// which can land during React's render/commit phase (e.g. a background query
// rejecting while a route is still mounting). Calling sonner's toast() there
// updates the <Toaster> store mid-mount and triggers React's "Can't perform a
// state update on a component that hasn't mounted yet" warning. Deferring to a
// macrotask guarantees the toast fires after the current commit.
function deferToastError<Failure>(error: Failure) {
  setTimeout(() => toast.error(getErrorMessage(error)), 0);
}

export interface RootMutationSuccessRuntime {
  registeredInvalidations<Variables>(
    operation: string | undefined,
    variables: Variables,
  ): InvalidationTagSet;
  afterSuccess<Result>(options: {
    queryClient: QueryClient;
    result: Result;
    invalidations: InvalidationTagSet;
  }): void;
}

const productionMutationSuccessRuntime: RootMutationSuccessRuntime = {
  registeredInvalidations: (operation, variables) =>
    operationInvalidationTags(operation, variables) ??
    EMPTY_INVALIDATION_TAG_SET,
  afterSuccess: ({ queryClient, invalidations }) => {
    void invalidateOperationTags(queryClient, invalidations);
    // A mutation's own derived work (an AI description, a recomputed
    // valuation, a refreshed embedding) lands on the queue shortly after this
    // returns — there is no batch left to watch, so re-check on a fixed
    // schedule instead.
    scheduleDeferredInvalidation(queryClient, invalidations);
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
        mutationSuccessRuntime.afterSuccess({
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
  const navigate = useNavigate();

  return (
    <AuthQueryProvider>
      <AuthUIProviderTanstack
        authClient={authClient}
        navigate={(href) => navigate({ to: href })}
        replace={(href) => navigate({ to: href, replace: true })}
        Link={Link}
        social={{
          providers: ["google"],
          signIn: signInWithGoogle,
        }}
        apiKey={{ prefix: "cubby_" }}
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
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
