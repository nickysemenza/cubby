import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack";
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Link as TanStackLink, useNavigate } from "@tanstack/react-router";
import {
  createTRPCClient,
  httpBatchStreamLink,
  httpLink,
  loggerLink,
  splitLink,
} from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { TRPCProvider } from "~/integrations/trpc/react";
import type { TRPCRouter } from "~/integrations/trpc/router";
import { authClient } from "~/lib/auth-client";
import { getAppErrorDetails, getErrorMessage } from "~/lib/error-utils";
import { getFlag } from "~/lib/flags";
import { persister } from "./persister";

// Root query-key prefixes whose data is safe + useful to persist for offline
// warm starts. Auth/session, agent streams, and anything not listed are skipped
// so we never write sensitive data to IndexedDB.
const PERSISTED_ROOTS = new Set([
  "product",
  "location",
  "recipe",
  "inventory",
  "ingredient",
]);

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

function getUrl() {
  const base = (() => {
    if (typeof window !== "undefined") return "";
    return `http://localhost:${process.env.PORT ?? 3000}`;
  })();
  return `${base}/api/trpc`;
}

// Problems-page detector procedures routed through the unbatched link (see the
// splitLink below). Kept in sync with the cost-grouped procedures in the
// problems router.
const UNBATCHED_PATHS = new Set([
  "problems.getFast",
  "problems.getCoverage",
  "problems.getAliases",
  "problems.getParses",
  "problems.getUpc",
]);

const trpcHeaders = () => {
  const headers = new Headers();
  headers.set("x-trpc-source", "tanstack-start");
  return headers;
};

const trpcClient = createTRPCClient<TRPCRouter>({
  links: [
    loggerLink({
      // Verbose logging is flag-controlled (queryLogger, default on in dev);
      // errors always log. Flippable on /settings, even in prod.
      enabled: (op) =>
        !import.meta.env.SSR &&
        (getFlag("queryLogger") ||
          (op.direction === "down" && op.result instanceof Error)),
    }),
    splitLink({
      // The Problems page's cost-grouped detector queries MUST NOT batch: if
      // they shared one HTTP request they'd run in a single Worker invocation
      // and re-sum all the detector CPU (re-parsing every recipe line through
      // WASM twice), which exceeded the 30s CPU limit. Route them through an
      // unbatched httpLink so each is its own invocation/CPU budget. Everything
      // else keeps the batched-stream link.
      condition: (op) => UNBATCHED_PATHS.has(op.path),
      true: httpLink({
        transformer: superjson,
        url: getUrl(),
        headers: trpcHeaders,
      }),
      false: httpBatchStreamLink({
        transformer: superjson,
        url: getUrl(),
        // Cap the batched-GET URL length so large fan-outs (e.g. the cookbook
        // import previewing hundreds of unique ingredients via getByName) split
        // into several requests instead of one giant URL that exceeds the
        // server's header-size limit (431 Request Header Fields Too Large). Kept
        // well under the typical 16KB request-line limit to leave room for
        // cookies/headers.
        maxURLLength: 8000,
        headers: trpcHeaders,
      }),
    }),
  ],
});

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
      onError: (error) => {
        const details = getAppErrorDetails(error);
        const isExpectedError =
          details.code === "NOT_FOUND" ||
          details.code === "UNAUTHORIZED" ||
          details.code === "BAD_REQUEST";
        if (isExpectedError) return;
        deferToastError(error);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        deferToastError(error);
      },
    }),
  });

  const serverHelpers = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient: queryClient,
  });
  return {
    queryClient,
    trpc: serverHelpers,
  };
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
        apiKey
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
                  // tRPC keys are nested: [["product","list"], { input, type }].
                  const head = query.queryKey?.[0];
                  const root = Array.isArray(head) ? head[0] : head;
                  const procedure = Array.isArray(head) ? head[1] : undefined;
                  // Persist lighter detail queries for offline warm starts, but
                  // NOT the big `.list` payloads. superjson-serializing a list
                  // (now up to 1000 rows) on every cache write was the dominant
                  // main-thread cost — profiled at ~38% of scroll-time CPU, with
                  // zero network in that window. Lists refetch fast from the
                  // server; the persist serialize isn't worth the jank.
                  return (
                    typeof root === "string" &&
                    PERSISTED_ROOTS.has(root) &&
                    procedure !== "list" &&
                    query.state.status === "success"
                  );
                },
              },
            }}
          >
            <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
              {children}
            </TRPCProvider>
          </PersistQueryClientProvider>
        ) : (
          <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
            {children}
          </TRPCProvider>
        )}
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
