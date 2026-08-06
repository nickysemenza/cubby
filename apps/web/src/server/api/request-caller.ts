import { getRequest } from "@tanstack/react-start/server";
import { createTRPCClient, unstable_localLink } from "@trpc/client";
import superjson from "superjson";
import { domainRouter } from "~/server/api/domain";
import { createTRPCContext } from "~/server/api/trpc";

/**
 * Create an in-process tRPC client for the current TanStack Start request.
 *
 * SSR loaders must not self-fetch `/api/trpc`: Cloudflare Workers cannot reach
 * the app through localhost, and a synthetic request would lose the signed
 * session cookie. The local link reuses the incoming headers and preserves the
 * normal tRPC context, authentication, middleware, output validation, SuperJSON
 * transformation, and formatted client errors without an HTTP hop inside the
 * same Worker invocation.
 */
export function createRequestDomainClient() {
  return createTRPCClient<typeof domainRouter>({
    links: [
      unstable_localLink({
        router: domainRouter,
        transformer: superjson,
        createContext: async () =>
          createTRPCContext({
            headers: getRequest().headers,
          }),
      }),
    ],
  });
}
