/**
 * Unified tracing utilities for consistent span naming and tracer instances
 */
import { trace, Span, SpanStatusCode } from '@opentelemetry/api';

// Single tracer instance for the entire application
const tracer = trace.getTracer('usda-api');

/**
 * Unified trace naming conventions
 */
export const TraceNames = {
  // HTTP routes
  route: (method: string, path: string) => `${method} ${path}`,

  // Database operations
  db: (operation: string, table?: string) =>
    table ? `db.${operation}.${table}` : `db.${operation}`,

  // Food operations
  food: (operation: string) => `food.${operation}`,

  // Search operations
  search: (operation: string) => `search.${operation}`,
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
  fn: (span: Span) => Promise<T>,
  attributes?: Record<string, string | number | boolean>
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
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    } finally {
      span.end();
    }
  });
};

/**
 * Synchronous version of withTrace for non-async operations
 */
export const withTraceSync = <T>(
  name: string,
  fn: (span: Span) => T,
  attributes?: Record<string, string | number | boolean>
): T => {
  return tracer.startActiveSpan(name, (span) => {
    if (attributes) {
      span.setAttributes(attributes);
    }
    try {
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(
        error instanceof Error ? error : new Error(String(error))
      );
      throw error;
    } finally {
      span.end();
    }
  });
};
