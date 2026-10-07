import {
  assertResponseContentType,
  fetchExternalResponse,
  MAX_EXTERNAL_HTML_BYTES,
  readResponseWithLimit,
} from "@cubby/shared/external-fetch";

import { urlAllowed } from "./browser-page";

/**
 * A public product page read without the Mac. Vendors often refuse a server
 * (bot walls, sign-in redirects), so a refusal is an expected answer, not an
 * error: the caller falls back to the Mac's signed-in browser and records why.
 */
type ServerPageFetch =
  | { status: "fetched"; url: string; html: string; durationMs: number }
  | { status: "blocked"; reason: string; durationMs: number };

export type FetchPage = (
  url: string,
  allowedHosts: readonly string[],
) => Promise<ServerPageFetch>;

/** Markers of a bot wall or challenge page served instead of the product. */
const CHALLENGE = [
  /captcha/iu,
  /robot check/iu,
  /cf-challenge|challenge-platform/iu,
  /access denied/iu,
  /px-captcha|perimeterx/iu,
  /are you a human/iu,
];

/** `fetcher` is the network; tests pass a scripted one. */
export const publicPageFetcher =
  (fetcher: typeof fetch = fetch): FetchPage =>
  async (url, allowedHosts) => {
    const started = Date.now();
    const blocked = (reason: string): ServerPageFetch => ({
      status: "blocked",
      reason,
      durationMs: Date.now() - started,
    });
    // A redirect off the vendor's hosts is a sign-in or a different site, and
    // the page is read at the URL it was served from (a redirect to another
    // `?variant=` is a different variant).
    let finalURL = url;
    try {
      const response = await fetchExternalResponse(url, {
        fetcher,
        method: "GET",
        timeoutMs: 15_000,
        headers: {
          accept: "text/html,application/xhtml+xml",
          "accept-language": "en-US,en;q=0.9",
        },
        onRedirect: (target) => {
          if (!urlAllowed(target.href, allowedHosts))
            throw new Error("redirected off the vendor's site");
          finalURL = target.href;
        },
      });
      if (!response.ok) return blocked(`HTTP ${response.status}`);
      assertResponseContentType(response, [
        "text/html",
        "application/xhtml+xml",
      ]);
      const html = new TextDecoder().decode(
        await readResponseWithLimit(response, MAX_EXTERNAL_HTML_BYTES),
      );
      const head = html.slice(0, 20_000);
      if (html.length < 2_000 || CHALLENGE.some((marker) => marker.test(head)))
        return blocked("challenge or empty page");
      return {
        status: "fetched",
        url: finalURL,
        html,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return blocked(error instanceof Error ? error.message : String(error));
    }
  };

export const fetchPublicPage = publicPageFetcher();
