import type { APIRequestContext } from "@playwright/test";
import { z } from "zod";

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/**
 * workerd closes an idle keep-alive connection after its fixed 5s pipeline
 * timeout, while Playwright's request agent keeps idle sockets indefinitely.
 * A request written to a reused socket just as workerd closes it is never
 * processed and fails with "socket hang up" (ECONNRESET). Retry idempotent
 * requests once on a fresh socket; Playwright only retries ECONNRESET, and a
 * POST or PATCH is never replayed.
 */
export function retryStaleKeepAlive(api: APIRequestContext): void {
  const fetch = api.fetch.bind(api);
  api.fetch = (urlOrRequest, options = {}) => {
    // A replayed browser Request keeps its own method; leave it unretried.
    const method =
      options.method ??
      (z.string().safeParse(urlOrRequest).success ? "GET" : undefined);
    return fetch(
      urlOrRequest,
      method && IDEMPOTENT_METHODS.has(method.toUpperCase())
        ? { maxRetries: 1, ...options }
        : options,
    );
  };
}
