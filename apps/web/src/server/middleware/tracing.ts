/**
 * TanStack Start tracing middleware
 * Traces all server-side requests including auth and explicit API routes
 */

import { createMiddleware } from "@tanstack/react-start";
import {
  readStartOperationTraceContext,
  serverFunctionTraceName,
  startOperationTraceAttributes,
} from "~/lib/start-operation-observability";
import { TraceNames, withTrace } from "~/server/tracing";

export const tracingMiddleware = createMiddleware().server(
  async ({ handlerType, next, request }) => {
    const url = new URL(request.url);
    const startContext =
      handlerType === "serverFn"
        ? readStartOperationTraceContext(request.headers)
        : undefined;
    const traceName = startContext
      ? serverFunctionTraceName(startContext)
      : handlerType === "serverFn"
        ? "start.serverFn"
        : TraceNames.route(request.method, url.pathname);

    return withTrace(traceName, async (span) => {
      // Do not export a server-function id or GET payload. The validated
      // Start context carries the useful semantic grouping instead.
      span.setAttributes({
        "http.request.method": request.method,
        "http.route":
          handlerType === "serverFn" ? "/_serverFn/:functionId" : url.pathname,
        ...startOperationTraceAttributes(startContext),
      });

      const result = await next();
      span.setAttribute("http.response.status_code", result.response.status);
      return result;
    });
  },
);
