import type { APIRequestContext } from "@playwright/test";
import superjson from "superjson";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "../../src/lib/browser-operation-path";
import { superJsonResultSchema } from "../../src/lib/superjson-wire";

const requestOrigins = new WeakMap<APIRequestContext, Promise<string>>();

/**
 * Runs browser-only operations through the same Start dispatch as the app,
 * from a signed-in request context (the dispatch requires a same-origin
 * `Origin`).
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
  const response = await request.post(BROWSER_OPERATION_PATH, {
    headers: { Origin: await origin, "Content-Type": "application/json" },
    data: JSON.stringify(superjson.serialize({ operation, input })),
  });
  const envelope = z
    .object({
      ok: z.boolean(),
      data: z.unknown().optional(),
      error: z.unknown().optional(),
    })
    .parse(
      superjson.deserialize(
        superJsonResultSchema.parse(JSON.parse(await response.text())),
      ),
    );
  const body = envelope.ok ? envelope.data : envelope.error;
  return {
    body,
    status: () => response.status(),
    ok: () => response.ok() && envelope.ok,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}
