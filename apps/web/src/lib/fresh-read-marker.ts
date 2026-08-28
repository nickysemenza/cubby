import { HYPERDRIVE_CACHE_POLICY } from "~/lib/hyperdrive-cache-policy";

/** Cookie shared by browser mutations and the server's read-consistency gate. */
export const FRESH_READ_COOKIE_NAME = "cubby-fresh-reads";

/**
 * Return whether the request carries the short-lived post-mutation marker.
 *
 * Keep this parser independent from browser globals: request-context uses it on
 * Workers, while the browser writer below is intentionally a no-op during SSR.
 */
export function hasFreshReadMarker(headers: Pick<Headers, "get">): boolean {
  const cookie = headers.get("cookie");
  if (!cookie) return false;

  return cookie.split(";").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return false;
    return (
      part.slice(0, separator).trim() === FRESH_READ_COOKIE_NAME &&
      part.slice(separator + 1).trim() === "1"
    );
  });
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
  if (typeof document === "undefined") return;

  const secure =
    typeof location !== "undefined" && location.protocol === "https:";
  // This browser transport seam intentionally writes the short-lived consistency marker.
  document.cookie = [
    `${FRESH_READ_COOKIE_NAME}=1`,
    `Max-Age=${HYPERDRIVE_CACHE_POLICY.freshReadSeconds}`,
    "Path=/",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
