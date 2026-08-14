import { getRequest } from "@tanstack/react-start/server";
import { type TRPCLink, unstable_localLink } from "@trpc/client";
import superjson from "superjson";
import type { TRPCRouter } from "~/integrations/trpc/router";
import { domainRouter } from "~/server/api/domain";
import { createTRPCContext } from "~/server/api/trpc";

/**
 * In-process transport for the server render.
 *
 * The HTTP links cannot be used here: their URL resolves to
 * `http://localhost:PORT/api/trpc`, which carries no session cookie and, on CF
 * Workers, never reaches the app at all — the edge answers with the plain-text
 * body `error code: 1003` and the response fails to parse. The local link keeps
 * the whole tRPC pipeline (context, auth middleware, output validation,
 * SuperJSON) while skipping the HTTP hop, so an SSR query runs authenticated
 * inside the same Worker invocation that renders the page.
 *
 * `getRequest()` reads from AsyncLocalStorage, so a module-scoped link still
 * resolves the *current* request's headers on every call — the client does not
 * need to be rebuilt per request.
 *
 * Bound to `domainRouter`, not `appRouter`: `agent.*` is user-initiated
 * streaming that never runs during a render, and keeping it out avoids pulling
 * the agent runtime's LLM SDKs into the server render path. The cast reconciles
 * that narrower router with the client's `AppRouter` type; an SSR call to
 * `agent.*` would fail loudly rather than silently self-fetch.
 */
export function createLocalTransportLink(): TRPCLink<TRPCRouter> {
  return unstable_localLink({
    router: domainRouter,
    transformer: superjson,
    createContext: async () =>
      createTRPCContext({ headers: getRequest().headers }),
  }) as unknown as TRPCLink<TRPCRouter>;
}
