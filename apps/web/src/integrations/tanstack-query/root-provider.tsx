import { AuthQueryProvider } from "@daveyplate/better-auth-tanstack";
import { AuthUIProviderTanstack } from "@daveyplate/better-auth-ui/tanstack";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { Link as TanStackLink, useNavigate } from "@tanstack/react-router";
import {
  createTRPCClient,
  httpBatchStreamLink,
  loggerLink,
} from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import superjson from "superjson";
import { TRPCProvider } from "~/integrations/trpc/react";
import type { TRPCRouter } from "~/integrations/trpc/router";
import { authClient } from "~/lib/auth-client";
import { getAppErrorDetails, getErrorMessage } from "~/lib/error-utils";

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

function getUrl() {
  const base = (() => {
    if (typeof window !== "undefined") return "";
    return `http://localhost:${process.env.PORT ?? 3000}`;
  })();
  return `${base}/api/trpc`;
}

const trpcClient = createTRPCClient<TRPCRouter>({
  links: [
    loggerLink({
      enabled: (op) =>
        !import.meta.env.SSR &&
        (process.env.NODE_ENV === "development" ||
          (op.direction === "down" && op.result instanceof Error)),
    }),
    httpBatchStreamLink({
      transformer: superjson,
      url: getUrl(),
      // Cap the batched-GET URL length so large fan-outs (e.g. the cookbook
      // import previewing hundreds of unique ingredients via getByName) split
      // into several requests instead of one giant URL that exceeds the server's
      // header-size limit (431 Request Header Fields Too Large). Kept well under
      // the typical 16KB request-line limit to leave room for cookies/headers.
      maxURLLength: 8000,
      headers: () => {
        const headers = new Headers();
        headers.set("x-trpc-source", "tanstack-start");
        return headers;
      },
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
        toast.error(getErrorMessage(error));
      },
    }),
    mutationCache: new MutationCache({
      onError: (error) => {
        toast.error(getErrorMessage(error));
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
        toast={({ variant, message }) => {
          const text = message ?? "Something went wrong.";
          if (variant === "error") toast.error(text);
          else if (variant === "success") toast.success(text);
          else if (variant === "warning") toast.warning(text);
          else if (variant === "info") toast.info(text);
          else toast(text);
        }}
      >
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          {children}
        </TRPCProvider>
      </AuthUIProviderTanstack>
    </AuthQueryProvider>
  );
}
