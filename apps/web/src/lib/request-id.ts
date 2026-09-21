/**
 * Request-correlation id, shared by both sides of the wire.
 *
 * Lives in `lib/` rather than `server/tracing.ts` because the browser needs the
 * header name too, and importing anything under `~/server` from client code
 * would drag OTel — and the server router behind it — into the client bundle
 * (see `assertNoServerCodeInClient` in scripts/check-client-bundle.ts). Keep
 * this module free of every server import for that reason.
 *
 * The server fills the header via `getRequestId()` in `~/server/tracing`: an
 * OTel trace id in dev, the CF `cf-ray` in prod.
 */

import { START_OPERATIONS } from "~/lib/generated/start-operation-registry.gen";

/** Response header carrying the server's request id back to the client. */
import { type ErrorDiagnostics, sentryEventUrl } from "./error-diagnostics";

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
): Promise<Response> {
  const requestHeaders = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  const rawOperation = requestHeaders.get("x-cubby-operation");
  const operation =
    rawOperation && Object.hasOwn(START_OPERATIONS, rawOperation)
      ? rawOperation
      : undefined;
  const response = await fetchImpl(input, init);
  const requestId = response.headers.get(REQUEST_ID_HEADER);
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
  if (response.status >= 500 && operation) {
    const eventId = response.headers.get("x-sentry-event-id") ?? undefined;
    const message = `Server request failed (HTTP ${response.status})`;
    const diagnostics: ErrorDiagnostics = {
      origin: "server",
      operation,
      stage: "dispatch",
      causes: [],
    };
    if (eventId) {
      diagnostics.sentryEventId = eventId;
      diagnostics.sentryUrl = sentryEventUrl(eventId);
    }
    const data: ServerResponseError["data"] = {
      code: "INTERNAL_SERVER_ERROR",
      diagnostics,
    };
    if (requestId) data.requestId = requestId;
    throw new ServerResponseError(message, data);
  }
  return response;
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
