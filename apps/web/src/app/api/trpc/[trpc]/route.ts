import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { type NextRequest } from "next/server";

import { env } from "~/env";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { TraceNames, withTrace } from "~/server/tracing";

/**
 * This wraps the `createTRPCContext` helper and provides the required context for the tRPC API when
 * handling a HTTP request (e.g. when you make requests from Client Components).
 */
const createContext = async (req: NextRequest) => {
  return createTRPCContext({
    headers: req.headers,
  });
};

const handler = async (req: NextRequest) => {
  const url = new URL(req.url);
  const pathSegments = url.pathname.split("/");
  const trpcPath = pathSegments.slice(3).join("/"); // Remove /api/trpc/ prefix

  return withTrace(
    TraceNames.route(req.method, `/api/trpc/${trpcPath}`),
    async (span) => {
      span.setAttributes({
        "http.method": req.method,
        "http.url": req.url,
        "trpc.path": trpcPath,
      });

      return fetchRequestHandler({
        endpoint: "/api/trpc",
        req,
        router: appRouter,
        createContext: () => createContext(req),
        onError:
          env.NODE_ENV === "development"
            ? ({
                path,
                error,
              }: {
                path?: string;
                error: { message: string; code?: string };
              }) => {
                // Don't log expected 4xx responses as failures
                const expectedCodes = [
                  "NOT_FOUND",
                  "UNAUTHORIZED",
                  "FORBIDDEN",
                  "BAD_REQUEST",
                  "CONFLICT",
                  "PRECONDITION_FAILED",
                ];
                if (error.code && expectedCodes.includes(error.code)) {
                  return; // Silent - these are expected responses, not failures
                }
                console.error(
                  `❌ tRPC failed on ${path ?? "<no-path>"}: ${error.message}`,
                );
              }
            : undefined,
      });
    },
  );
};

export { handler as GET, handler as POST };
