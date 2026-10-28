import type { APIRequestContext } from "@playwright/test";
import { browserOperationPath } from "#web/src/lib/browser-operation-path.ts";

const requestOrigins = new WeakMap<APIRequestContext, Promise<string>>();

/**
 * Runs browser-only operations through the same dispatch as the app, from a
 * signed-in request context (the dispatch requires a same-origin `Origin`).
 * A refusal is the bare error under its status; `body` is the data or error.
 */
export async function startOperation(
  request: APIRequestContext,
  operation: string,
  input: unknown,
) {
  let origin = requestOrigins.get(request);
  if (!origin) {
    origin = request
      .get("/api/auth/get-session")
      .then((response) => new URL(response.url()).origin);
    requestOrigins.set(request, origin);
  }
  const response = await request.post(browserOperationPath(operation), {
    headers: {
      Origin: await origin,
      "Content-Type": "application/json",
      "x-cubby-surface": "browser",
    },
    data: JSON.stringify({ operation, input }),
  });
  const value: { data?: unknown } = await response.json();
  const body = response.ok() ? value.data : value;
  return {
    body,
    status: () => response.status(),
    ok: () => response.ok(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
