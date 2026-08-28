import { HYPERDRIVE_CACHE_POLICY } from "~/lib/hyperdrive-cache-policy";

/** Cookie shared by browser mutations and the server's read-consistency gate. */
export const FRESH_READ_COOKIE_NAME = "cubby-fresh-reads";
/**
 * Start requests carry the same short-lived marker explicitly. Some runtime
 * adapters construct the browser-to-Worker request before they attach ambient
 * cookies, so relying on the cookie alone lets a just-invalidated query reach
 * a bounded-stale replica.
 */
export const FRESH_READ_HEADER_NAME = "x-cubby-fresh-read";

export interface BrowserCookieSource {
  readonly cookie: string;
}

const hasFreshReadCookie = (cookie: string): boolean =>
  cookie.split(";").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return false;
    return (
      part.slice(0, separator).trim() === FRESH_READ_COOKIE_NAME &&
      part.slice(separator + 1).trim() === "1"
    );
  });

const browserCookieSource = (): BrowserCookieSource | undefined =>
  globalThis.document;

/**
 * Return whether the request carries the short-lived post-mutation marker.
 *
 * Keep this parser independent from browser globals: request-context uses it on
 * Workers, while the browser writer below is intentionally a no-op during SSR.
 */
export function hasFreshReadMarker(headers: Pick<Headers, "get">): boolean {
  if (headers.get(FRESH_READ_HEADER_NAME) === "1") return true;
  const cookie = headers.get("cookie");
  return cookie !== null && hasFreshReadCookie(cookie);
}

/**
 * Copy the browser's post-write marker onto an operation request. The Worker
 * treats this as a read-consistency hint only; it cannot grant authority or
 * reveal data, and the cookie remains the durable navigation-path carrier.
 */
export function freshReadRequestHeaders(
  source: BrowserCookieSource | undefined = browserCookieSource(),
): Record<string, string> {
  return source && hasFreshReadCookie(source.cookie)
    ? { [FRESH_READ_HEADER_NAME]: "1" }
    : {};
}

/**
 * Mark subsequent browser reads as strongly consistent for a short window.
 *
 * `document` is checked at call time rather than import time so this module can
 * be imported by server request code without pulling browser-only state into
 * the Worker bundle. Secure is omitted for local HTTP previews, where browsers
 * otherwise reject the cookie.
 */
export function markFreshReads(): void {
  if (globalThis.document === undefined) return;

  const secure =
    globalThis.location !== undefined && location.protocol === "https:";
  // This browser transport seam intentionally writes the short-lived consistency marker.
  document.cookie = [
    `${FRESH_READ_COOKIE_NAME}=1`,
    `Max-Age=${HYPERDRIVE_CACHE_POLICY.freshReadSeconds}`,
    "Path=/",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
