import { createIsomorphicFn } from "@tanstack/react-start";
import type { TRPCLink } from "@trpc/client";
import { createTRPCTransportLink } from "~/integrations/tanstack-query/trpc-transport";
import { createLocalTransportLink } from "~/integrations/tanstack-query/trpc-transport-server";
import type { TRPCRouter } from "~/integrations/trpc/router";

function getBrowserUrl() {
  return "/api/trpc";
}

/**
 * Pick the tRPC transport for the environment the code is running in.
 *
 * The Start plugin replaces this call with the matching implementation at build
 * time, so `trpc-transport-server` — and through it the whole domain router —
 * is stripped from the browser bundle. Nothing in the type system enforces
 * that, so `assertNoServerCodeInClient` in `scripts/analyze-client-bundle.ts`
 * fails `build:cf` if the strip ever regresses; without it a leak would ship
 * the server router, and the database driver behind it, to every visitor.
 *
 * The browser keeps the batched HTTP links. The server render uses an
 * in-process link instead of self-fetching `http://localhost:PORT/api/trpc`,
 * which is unreachable on CF Workers and unauthenticated everywhere.
 */
export const createTransportLink = createIsomorphicFn()
  .client(
    (): TRPCLink<TRPCRouter> =>
      createTRPCTransportLink({ url: getBrowserUrl() }),
  )
  .server((): TRPCLink<TRPCRouter> => createLocalTransportLink());
