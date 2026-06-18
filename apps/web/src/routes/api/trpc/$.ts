import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { getActiveTraceId } from "~/server/tracing";

const handler = ({ request }: { request: Request }) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: async () => createTRPCContext({ headers: request.headers }),
    responseMeta: () => {
      // Undefined in the CF backend (no OTel active-span accessor); the header
      // is simply omitted there.
      const traceId = getActiveTraceId();
      return {
        headers: traceId ? { "x-trace-id": traceId } : {},
      };
    },
  });
};

export const Route = createFileRoute("/api/trpc/$")({
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
