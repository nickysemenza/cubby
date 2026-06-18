/**
 * TanStack Start tracing middleware
 * Traces all server-side requests including auth routes that bypass tRPC
 */

import { createMiddleware } from "@tanstack/react-start";
import { TraceNames, withTrace } from "~/server/tracing";

export const tracingMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const url = new URL(request.url);

    return withTrace(
      TraceNames.route(request.method, url.pathname),
      async (span) => {
        // Stable OTel HTTP semantic conventions.
        span.setAttributes({
          "http.request.method": request.method,
          "url.full": request.url,
          "http.route": url.pathname,
        });

        const result = await next();
        span.setAttribute("http.response.status_code", result.response.status);
        return result;
      },
    );
  },
);
