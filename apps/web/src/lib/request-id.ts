/**
 * Request-correlation id, shared by both sides of the wire.
 *
 * Lives in `lib/` rather than `server/observability/tracing.ts` because the browser needs the
 * header name too. Only client-safe wire contracts may cross this seam;
 * server implementations must never enter this module's import graph.
 *
 * The server fills the header via `getRequestId()` in `~/server/observability/tracing`: an
 * Cloudflare `cf-ray` when available.
 */

import type { z } from "zod";

import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";
import { publicStartOperationErrorSchema } from "~/server/operation-runtime/start-operation.contract";

/** Response header carrying the server's request id back to the client. */
import {
  CLOUDFLARE_OBSERVABILITY_URL,
  describeErrorCauses,
  type ErrorDiagnostics,
  scrubErrorMessage,
  sentryEventUrl,
} from "./error-diagnostics";
import { notifyNativeWorkspaceResponse } from "./native-workspace/bridge";

export const REQUEST_ID_HEADER = "x-request-id";

export type BrowserRequestDiagnostic = {
  operation?: string;
  requestId: string;
  status: number;
  at: number;
};

const requestDiagnostics: BrowserRequestDiagnostic[] = [];
const REQUEST_DIAGNOSTIC_LIMIT = 50;

export const getBrowserRequestDiagnostics = (): BrowserRequestDiagnostic[] => [
  ...requestDiagnostics,
];

/** Capture each response's own correlation id; never use a shared "last id". */
export async function fetchWithRequestDiagnostics(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
  context?: { operation: string },
): Promise<Response> {
  const requestHeaders = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const rawOperation = requestHeaders.get("x-cubby-operation");
  const operation =
    context?.operation ??
    (rawOperation && Object.hasOwn(START_OPERATIONS, rawOperation)
      ? rawOperation
      : undefined);
  const started = performance.now();
  const url = scrubErrorMessage(
    input instanceof Request ? input.url : String(input),
  );
  let response: Response;
  try {
    response = await fetchImpl(input, init);
  } catch (error) {
    if (
      !operation ||
      init?.signal?.aborted ||
      (input instanceof Request && input.signal.aborted)
    )
      throw error;
    throw new ServerResponseError(
      scrubErrorMessage(error instanceof Error ? error.message : String(error)),
      {
        code: "NETWORK_ERROR",
        diagnostics: {
          origin: "server",
          operation,
          stage: "http",
          ...describeErrorCauses(error, { includeStacks: true }),
          http: { url, elapsedMs: performance.now() - started },
        },
      },
    );
  }
  const requestId = recordResponse(response, operation);
  if (!response.ok && operation) {
    const eventId = response.headers.get("x-sentry-event-id") ?? undefined;
    let body: string | undefined;
    let bodyFailure: Pick<ErrorDiagnostics, "causes" | "truncated"> = {
      causes: [],
    };
    try {
      body = scrubErrorMessage(await response.text());
    } catch (error) {
      if (
        init?.signal?.aborted ||
        (input instanceof Request && input.signal.aborted)
      )
        throw error;
      bodyFailure = describeErrorCauses(error, { includeStacks: true });
    }
    let publicError:
      | z.infer<typeof publicStartOperationErrorSchema>
      | undefined;
    try {
      publicError = publicStartOperationErrorSchema.safeParse(
        JSON.parse(body ?? ""),
      ).data;
    } catch {
      // SILENT: non-JSON bodies are expected here; the full raw body is surfaced below.
    }
    const message =
      publicError?.message ??
      `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}: ${body === undefined ? `response body could not be read: ${bodyFailure.causes.at(-1)?.message ?? "unknown read failure"}` : body || "empty response body"}`;
    const diagnostics: ErrorDiagnostics = {
      origin: "server",
      operation,
      stage: "http",
      ...bodyFailure,
      ...publicError?.diagnostics,
      http: {
        status: response.status,
        statusText: response.statusText,
        url,
        body,
        elapsedMs: performance.now() - started,
        contentType: response.headers.get("content-type") ?? undefined,
      },
    };
    const cfRayId = response.headers.get("cf-ray");
    if (cfRayId) {
      diagnostics.cfRayId = cfRayId;
      diagnostics.cloudflareUrl = CLOUDFLARE_OBSERVABILITY_URL;
    }
    if (eventId) {
      diagnostics.sentryEventId = eventId;
      diagnostics.sentryUrl = sentryEventUrl(eventId);
    }
    const data: ServerResponseError["data"] = {
      ...publicError,
      code: publicError?.code ?? "HTTP_ERROR",
      diagnostics,
    };
    if (requestId) data.requestId = requestId;
    throw new ServerResponseError(message, data);
  }
  return response;
}

/**
 * Record a response's own correlation id for browser diagnostics and let the
 * hosted native workspace observe it.
 */
export function recordResponse(
  response: Response,
  operation: string | undefined,
): string | null {
  notifyNativeWorkspaceResponse(response);
  const requestId =
    response.headers.get(REQUEST_ID_HEADER) ?? response.headers.get("cf-ray");
  if (requestId && globalThis.window !== undefined) {
    const diagnostic: BrowserRequestDiagnostic = {
      requestId,
      status: response.status,
      at: performance.now(),
    };
    if (operation) diagnostic.operation = operation;
    requestDiagnostics.push(diagnostic);
    if (requestDiagnostics.length > REQUEST_DIAGNOSTIC_LIMIT) {
      requestDiagnostics.shift();
    }
  }
  return requestId;
}

class ServerResponseError extends Error {
  constructor(
    message: string,
    readonly data: {
      code: string;
      requestId?: string;
      diagnostics: ErrorDiagnostics;
    },
  ) {
    super(message);
    this.name = "ServerResponseError";
  }
}
