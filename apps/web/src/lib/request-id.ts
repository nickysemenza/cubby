/**
 * Request-correlation id, shared by both sides of the wire.
 *
 * Lives in `lib/` rather than `server/tracing.ts` because the browser needs the
 * header name too, and importing anything under `~/server` from client code
 * would drag OTel — and the server router behind it — into the client bundle
 * (see `assertNoServerCodeInClient` in scripts/analyze-client-bundle.ts). Keep
 * this module free of every server import for that reason.
 *
 * The server fills the header via `getRequestId()` in `~/server/tracing`: an
 * OTel trace id in dev, the CF `cf-ray` in prod.
 */

/** Response header carrying the server's request id back to the client. */
export const REQUEST_ID_HEADER = "x-trace-id";

/**
 * Id from the most recent server response that carried one.
 *
 * Deliberately last-write-wins rather than a per-query map: the error UI only
 * ever asks "what was the id of the request that just failed". An id belongs to
 * the response that carried it, however many operations that response contains.
 */
let lastRequestId: string | undefined;

export const recordRequestId = (value: string | null | undefined): void => {
  if (value) lastRequestId = value;
};

export const getLastRequestId = (): string | undefined => lastRequestId;
