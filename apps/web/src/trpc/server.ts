import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { context, propagation } from "@opentelemetry/api";

import { createCaller } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { HydrateClient } from "./hydration-client";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a tRPC call from a React Server Component.
 */
const createContext = cache(async () => {
  const heads = new Headers(await headers());
  heads.set("x-trpc-source", "rsc");

  // No longer propagate legacy x-project-id; org context comes from Better‑Auth cookies

  // Inject current trace context into headers for propagation
  const activeContext = context.active();
  const traceHeaders: Record<string, string> = {};
  propagation.inject(activeContext, traceHeaders);

  // Add trace headers to the tRPC context
  Object.entries(traceHeaders).forEach(([key, value]) => {
    heads.set(key, value);
  });

  return createTRPCContext({
    headers: heads,
  });
});

// Create a direct server-side caller for server components
// This is the main export used by server components
const caller = createCaller(createContext);
export const api = caller;

// Re-export the client component
export { HydrateClient };
