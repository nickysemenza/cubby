import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { dehydrate } from "@tanstack/react-query";

import { createCaller } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { createQueryClient } from "./query-client";
import { HydrateClient } from "./hydration-client";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a tRPC call from a React Server Component.
 */
const createContext = cache(async () => {
  const heads = new Headers(await headers());
  heads.set("x-trpc-source", "rsc");

  return createTRPCContext({
    headers: heads,
  });
});

// Create a direct server-side caller for server components
// This is the main export used by server components
const caller = createCaller(createContext);
export const api = caller;

// Cache the query client to avoid recreating it on every request
const getQueryClient = cache(createQueryClient);

// Server-side function to prepare hydration data
export function getHydrationData() {
  const queryClient = getQueryClient();
  return dehydrate(queryClient);
}

// Re-export the client component
export { HydrateClient };
