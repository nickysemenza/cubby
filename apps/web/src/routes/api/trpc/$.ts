import { createFileRoute } from "@tanstack/react-router";
import { REQUEST_ID_HEADER } from "~/lib/request-id";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { handleTRPCFetchRequest } from "~/server/api/trpc-fetch-handler";
import { getRequestId } from "~/server/tracing";

const handler = ({ request }: { request: Request }) => {
  return handleTRPCFetchRequest({
    endpoint: "/api/trpc",
    req: request,
    router: appRouter,
    createContext: async () => createTRPCContext({ headers: request.headers }),
    responseMeta: () => {
      // An OTel trace id where a span is active, else the `cf-ray` header —
      // `getActiveTraceId()` alone is always undefined in the CF backend,
      // which made this header dead in prod. Omitted only when neither exists.
      const requestId = getRequestId(request.headers);
      return {
        headers: requestId ? { [REQUEST_ID_HEADER]: requestId } : {},
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
