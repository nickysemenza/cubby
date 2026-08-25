import { createIsomorphicFn } from "@tanstack/react-start";
import type { TRPCLink } from "@trpc/client";
import { createTRPCTransportLink } from "~/integrations/tanstack-query/trpc-transport";
import { createLocalTransportLink } from "~/integrations/tanstack-query/trpc-transport-server";
import type { TRPCRouter } from "~/integrations/trpc/router";
import { REQUEST_ID_HEADER, recordRequestId } from "~/lib/request-id";

function getBrowserUrl() {
  return "/api/trpc";
}

/**
 * `fetch` wrapper passed into the browser transport so it can capture the
 * server's request id off the response header and stash it for the error UI.
 * Never swallows or alters the response/error — just observes and forwards.
 *
 * This only ever runs in `.client()` below: the `.server()` branch uses
 * `createLocalTransportLink`, an in-process link with no HTTP round trip, so
 * there is nothing to wrap there — no double-instrumentation, no SSR leak of
 * a request id captured for a different request.
 *
 * The client link is `httpBatchStreamLink` with `maxItems: 50`, so one HTTP
 * response can carry up to 50 batched procedures. The id captured here is
 * therefore per-batch, not per-procedure — that's the correct granularity for
 * "what request failed", not a bug to fix.
 */
const fetchAndRecordRequestId: typeof globalThis.fetch = async (
  input,
  init,
) => {
  const response = await fetch(input, init);
  recordRequestId(response.headers.get(REQUEST_ID_HEADER));
  return response;
};

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
      createTRPCTransportLink({
        url: getBrowserUrl(),
        fetch: fetchAndRecordRequestId,
      }),
  )
  .server((): TRPCLink<TRPCRouter> => createLocalTransportLink());
