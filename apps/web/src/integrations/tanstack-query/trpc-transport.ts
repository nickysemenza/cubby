import {
  httpBatchStreamLink,
  httpLink,
  splitLink,
  type TRPCLink,
} from "@trpc/client";
import superjson from "superjson";
import type { TRPCRouter } from "~/integrations/trpc/router";
import { isUnbatchedTRPCPath } from "~/lib/problems-query-groups";

const trpcHeaders = () => {
  const headers = new Headers();
  headers.set("x-trpc-source", "tanstack-start");
  return headers;
};

export function createTRPCTransportLink({
  url,
  fetch,
}: {
  url: string;
  fetch?: typeof globalThis.fetch;
}): TRPCLink<TRPCRouter> {
  const sharedOptions = {
    transformer: superjson,
    url,
    methodOverride: "POST" as const,
    headers: trpcHeaders,
    ...(fetch ? { fetch } : {}),
  };

  return splitLink({
    // These Problems procedures need separate Worker invocations so their CPU
    // budgets are isolated. POST changes only where query input is carried; it
    // does not change this load-bearing batching boundary.
    condition: (op) => isUnbatchedTRPCPath(op.path),
    true: httpLink(sharedOptions),
    false: httpBatchStreamLink(sharedOptions),
  });
}
