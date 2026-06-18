/**
 * TanStack Start tracing middleware
 * Traces all server-side requests including auth routes that bypass tRPC
 */

import { SpanStatusCode } from "@opentelemetry/api";
import { createMiddleware } from "@tanstack/react-start";
import { getErrorMessage } from "~/lib/error-utils";
import { getTracer, TraceNames } from "~/server/tracing";

export const tracingMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const url = new URL(request.url);

    return getTracer().startActiveSpan(
      TraceNames.route(request.method, url.pathname),
      async (span) => {
        // Stable OTel HTTP semantic conventions.
        span.setAttributes({
          "http.request.method": request.method,
          "url.full": request.url,
          "http.route": url.pathname,
        });

        try {
          const result = await next();
          span.setAttribute(
            "http.response.status_code",
            result.response.status,
          );
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(
            error instanceof Error ? error : new Error(String(error)),
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: getErrorMessage(error),
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  },
);
