/**
 * TanStack Start tracing middleware
 * Traces all server-side requests including auth and explicit API routes
 */

import { createMiddleware } from "@tanstack/react-start";
import { httpRouteTemplate } from "~/lib/http-route-template";
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
    const routeTemplate = httpRouteTemplate(url.pathname, {
      serverFunction: handlerType === "serverFn",
    });
    const traceName = startContext
      ? serverFunctionTraceName(startContext)
      : handlerType === "serverFn"
        ? "start.serverFn"
        : TraceNames.route(request.method, routeTemplate);

    return withTrace(traceName, async (span) => {
      // Do not export a server-function id or GET payload. The validated
      // Start context carries the useful semantic grouping instead.
      span.setAttributes({
        "http.request.method": request.method,
        "http.route": routeTemplate,
        ...startOperationTraceAttributes(startContext),
      });

      const result = await next();
      span.setAttribute("http.response.status_code", result.response.status);
      return result;
    });
  },
);
