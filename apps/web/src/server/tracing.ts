/**
 * Unified tracing utilities for consistent span naming and tracer instances
 */
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { getErrorMessage } from "~/lib/error-utils";

// Single tracer instance for the entire application
const tracer = trace.getTracer("cubby");

/**
 * Unified trace naming conventions
 */
export const TraceNames = {
  // HTTP routes
  route: (method: string, path: string) => `${method} ${path}`,

  // tRPC procedures
  trpc: (type: string, path: string) => `trpc.${type}.${path}`,

  // External API calls
  api: (service: string, operation: string) => `api.${service}.${operation}`,

  // WASM operations
  wasm: (operation: string) => `wasm.${operation}`,

  // Service layer operations
  service: (service: string, operation: string) =>
    `service.${service}.${operation}`,

  // Database operations
  db: (operation: string) => `db.${operation}`,
} as const;

/**
 * Get the unified tracer instance
 */
export const getTracer = () => tracer;

/**
 * Utility to create consistent trace spans
 */
export const withTrace = async <T>(
  name: string,
  fn: (span: ReturnType<typeof tracer.startSpan>) => Promise<T>,
  attributes?: Record<string, string | number | boolean>,
): Promise<T> => {
  return tracer.startActiveSpan(name, async (span) => {
    if (attributes) {
      span.setAttributes(attributes);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: getErrorMessage(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
};
