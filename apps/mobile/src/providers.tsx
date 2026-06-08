import type { AppRouter } from "@cubby/api-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, loggerLink } from "@trpc/client";
import type { ReactNode } from "react";
import { useState } from "react";
import superjson from "superjson";
import { TRPC_URL } from "./lib/api-config";
import { getStoredApiKey } from "./lib/session-key";
import { TRPCProvider } from "./lib/trpc";

// React Native has no cookie jar and no streaming fetch body, so this differs
// from web in two ways: httpBatchLink (not the stream link), and auth attached
// manually via the x-api-key header (read from SecureStore per request).
//
// Offline query persistence is intentionally NOT wired here yet (deferred) — a
// plain QueryClient keeps the spine simple.
export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 60 * 1000, retry: false },
        },
      }),
  );

  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            __DEV__ || (op.direction === "down" && op.result instanceof Error),
        }),
        httpBatchLink({
          transformer: superjson,
          url: TRPC_URL,
          // Cap batched-GET URL length (matches web) to avoid 431s on large fan-outs.
          maxURLLength: 8000,
          // credentials:"omit" dodges the Expo duplicate-cookie / Invalid-Base64
          // bug; we attach auth explicitly via x-api-key below.
          fetch: (url, options) =>
            fetch(url as string, { ...options, credentials: "omit" }),
          async headers() {
            const key = await getStoredApiKey();
            return {
              "x-trpc-source": "expo",
              ...(key ? { "x-api-key": key } : {}),
            };
          },
        }),
      ],
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
