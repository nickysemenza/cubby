// Shim for ~/trpc/server
// TanStack Start doesn't use React Server Components, so this pattern needs to be replaced
// with route loaders or server functions

import { createCaller } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

// Create a basic context for server-side calls
// In TanStack Start, you should use route loaders or createServerFn instead
const createContext = async (headers: Headers = new Headers()) => {
  headers.set("x-trpc-source", "server");
  return createTRPCContext({ headers });
};

// Server-side caller - use this in server functions or loaders
export const createServerCaller = async (headers?: Headers) => {
  return createCaller(await createContext(headers));
};

// For backward compatibility - creates caller with empty headers
// NOTE: This won't have auth context. Prefer createServerCaller with actual headers.
export const api = createCaller(createContext);

// HydrateClient is not needed in TanStack Start
export const HydrateClient = ({ children }: { children: React.ReactNode }) =>
  children;
