import { AsyncLocalStorage } from "node:async_hooks";

import * as Sentry from "@sentry/tanstackstart-react";

import { isExpectedAppError } from "./app-error";

type ErrorReports = {
  events: Map<unknown, Map<string, string | undefined>>;
  headers?: Headers;
  capture: typeof Sentry.captureException;
};
const reports = new AsyncLocalStorage<ErrorReports>();

/** Reuse one request scope through nested adapters and asynchronous stream work. */
export function withErrorReporting<T>(
  run: () => T,
  headers?: Headers,
  capture = Sentry.captureException,
): T {
  return reports.getStore()
    ? run()
    : reports.run({ events: new Map(), headers, capture }, run);
}

export function reportServerError<TError>(
  error: TError,
  context: {
    operation?: string;
    requestId?: string;
    stage?: string;
    batchIndex?: number;
  } = {},
): string | undefined {
  if (isExpectedAppError(error)) return undefined;
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "CancelledError")
  )
    return undefined;
  const store = reports.getStore()?.events;
  const key = `${context.operation ?? ""}:${context.batchIndex ?? ""}`;
  const previous = store?.get(error);
  if (previous?.has(key)) return previous.get(key);
  if (!context.operation && previous?.size)
    return previous.values().next().value;
  const eventId = captureError(error, context);
  const captures = previous ?? new Map<string, string | undefined>();
  captures.set(key, eventId);
  store?.set(error, captures);
  return eventId;
}

function captureError<TError>(
  error: TError,
  context: {
    operation?: string;
    requestId?: string;
    stage?: string;
    batchIndex?: number;
  },
): string | undefined {
  // Telemetry must never replace the original failure.
  try {
    return (reports.getStore()?.capture ?? Sentry.captureException)(error, {
      tags: {
        request_id:
          context.requestId ?? reports.getStore()?.headers?.get("cf-ray"),
        operation: context.operation,
        stage: context.stage,
      },
      extra: { batchIndex: context.batchIndex },
    });
  } catch {
    return undefined;
  }
}

export const errorReportingHeaders = (): Headers | undefined =>
  reports.getStore()?.headers;
