import * as Sentry from "@sentry/tanstackstart-react";
import { flatten } from "flat";
import { getErrorMessage } from "~/lib/error-utils";
import { isExpectedAppError } from "~/server/errors/app-error";
import { type AppSpan, withTrace } from "~/server/tracing";
import type { RequestOrigin, Workload } from "~/server/workload";

const SENSITIVE_KEY =
  /pass|token|secret|cookie|authorization|api.?key|url|uri/i;
const INPUT_BYTES_CAP = 4096;

export function recordObservedInput(
  span: AppSpan,
  input: unknown,
  includeValues = true,
): void {
  if (input == null || typeof input !== "object") return;
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return;
  }
  span.setAttribute("rpc.input.bytes", serialized.length);
  if (!includeValues) return;
  if (serialized.length > INPUT_BYTES_CAP) {
    span.setAttribute("rpc.input.truncated", true);
    return;
  }
  const values = flatten({ "rpc.input": input }) as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      continue;
    }
    span.setAttribute(key, SENSITIVE_KEY.test(key) ? "[redacted]" : value);
  }
}

type ObservedResult = { error?: unknown; workload?: Workload };

export function isObservedCancellation(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error &&
      (error.name === "AbortError" || error.name === "CancelledError"))
  );
}

export async function observeRequest<T>(options: {
  system: "start" | "trpc";
  method: string;
  type: "query" | "mutation" | "subscription";
  origin: RequestOrigin;
  actorId?: string | null;
  input: unknown;
  workload: Workload;
  operationId?: string;
  includeInputValues?: boolean;
  run: (span: AppSpan) => Promise<T>;
  inspectResult?: (result: T) => ObservedResult;
}): Promise<T> {
  const traceName = `${options.system}.${options.type}.${options.method}`;
  return await withTrace(traceName, async (span) => {
    span.setAttributes({
      "rpc.system": options.system,
      "rpc.method": options.method,
      "rpc.type": options.type,
      "enduser.id": options.actorId ?? "guest",
      "cubby.request_origin": options.origin,
      "cubby.workload": options.workload,
      "cubby.operation_id": options.operationId,
    });
    recordObservedInput(
      span,
      options.input,
      options.includeInputValues ?? true,
    );
    try {
      const result = await options.run(span);
      const inspection = options.inspectResult?.(result);
      if (inspection?.workload) {
        span.setAttribute("cubby.workload", inspection.workload);
      }
      if (inspection?.error) {
        if (isObservedCancellation(inspection.error)) {
          span.setAttribute("cubby.cancelled", true);
          return result;
        }
        span.setError(getErrorMessage(inspection.error));
        if (!isExpectedAppError(inspection.error)) {
          Sentry.captureException(inspection.error, {
            extra: {
              rpcMethod: options.method,
              rpcSystem: options.system,
              rpcType: options.type,
            },
          });
        }
      }
      return result;
    } catch (error) {
      if (isObservedCancellation(error)) {
        span.setAttribute("cubby.cancelled", true);
        throw error;
      }
      if (!isExpectedAppError(error)) {
        Sentry.captureException(error, {
          extra: {
            rpcMethod: options.method,
            rpcSystem: options.system,
            rpcType: options.type,
          },
        });
      }
      throw error;
    }
  });
}
