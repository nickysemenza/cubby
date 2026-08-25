import { REQUEST_ID_HEADER } from "./request-id";

const HTML_CACHE_CONTROL = "private, no-cache, must-revalidate";

/** Stamp a request id on a streamed response without consuming its body. */
export function withRequestId(
  response: Response,
  requestId?: string,
): Response {
  if (!requestId) return response;
  const headers = new Headers(response.headers);
  headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Force every SSR HTML document to revalidate while preserving its stream, and
 * stamp the request id on it when one is known.
 *
 * The content-type guard is what keeps both concerns safe: rebuilding a
 * null-body response (204/304) throws, so only responses we already know carry
 * an HTML stream are reconstructed. Non-HTML responses pass through untouched
 * and deliberately get no request-id header — do not generalize this.
 */
export function withHtmlNoCache(
  response: Response,
  requestId?: string,
): Response {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!contentType?.startsWith("text/html")) return response;

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", HTML_CACHE_CONTROL);
  if (requestId) headers.set(REQUEST_ID_HEADER, requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
