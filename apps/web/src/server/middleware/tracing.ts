/**
 * TanStack Start tracing middleware
 * Traces all server-side requests including auth routes that bypass tRPC
 */

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { createMiddleware } from "@tanstack/react-start";

const tracer = trace.getTracer("tanstack-start");

export const tracingMiddleware = createMiddleware().server(
  async ({ next, request }) => {
    const url = new URL(request.url);

    return tracer.startActiveSpan(
      `${request.method} ${url.pathname}`,
      async (span) => {
        span.setAttributes({
          "http.method": request.method,
          "http.url": request.url,
          "http.route": url.pathname,
        });

        try {
          const result = await next();
          span.setAttribute("http.status_code", result.response.status);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.recordException(
            error instanceof Error ? error : new Error(String(error)),
          );
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        } finally {
          span.end();
        }
      },
    );
  },
);
