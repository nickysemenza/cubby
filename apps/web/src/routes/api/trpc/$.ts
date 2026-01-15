import { trace } from "@opentelemetry/api";
import { createFileRoute } from "@tanstack/react-router";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";

const handler = ({ request }: { request: Request }) => {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: async () => createTRPCContext({ headers: request.headers }),
    responseMeta: () => {
      const traceId = trace.getActiveSpan()?.spanContext().traceId;
      return {
        headers: traceId ? { "x-trace-id": traceId } : {},
      };
    },
  });
};

export const Route = createFileRoute("/api/trpc/$")({
  // @ts-expect-error - TanStack Start server handlers type not yet in @tanstack/react-router
  server: {
    handlers: {
      GET: handler,
      POST: handler,
    },
  },
});
