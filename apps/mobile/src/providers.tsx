import type { AppRouter } from "@cubby/api-contract";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, loggerLink } from "@trpc/client";
import type { ReactNode } from "react";
import { useState } from "react";
import superjson from "superjson";
import { RecipebridgeHost } from "./components/recipebridge-host";
import { TRPC_URL } from "./lib/api-config";
import { authClient } from "./lib/auth-client";
import { TRPCProvider } from "./lib/trpc";

// React Native has no cookie jar and no streaming fetch body, so this differs
// from web in two ways: httpBatchLink (not the stream link), and the session
// cookie is attached manually. @better-auth/expo persists the cookie in
// SecureStore and exposes authClient.getCookie() — the same session the browser
// sends automatically on web. (No API key needed; the server authenticates the
// cookie via getSession exactly as it does for the web client.)
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
          // bug; we set the Cookie header manually instead.
          fetch: (url, options) =>
            fetch(url as string, { ...options, credentials: "omit" }),
          headers() {
            return {
              "x-trpc-source": "expo",
              Cookie: authClient.getCookie(),
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
        {/* Off-screen WebView host that runs the recipebridge WASM on-device. */}
        <RecipebridgeHost />
      </TRPCProvider>
    </QueryClientProvider>
  );
}
