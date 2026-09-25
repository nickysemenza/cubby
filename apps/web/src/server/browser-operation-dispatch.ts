import superjson from "superjson";

import { superJsonResultSchema } from "~/lib/superjson-wire";
import { startOperationDispatchInput } from "~/server/start-operation-dispatch.contract";
import { dispatchStartOperation } from "~/server/start-operation-dispatch.server";
import { normalizeStartOperationError } from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";

export async function handleBrowserOperationDispatch(
  request: Request,
): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  if (request.method !== "POST")
    return Response.json(
      superjson.serialize({
        ok: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "POST required" },
      }),
      { status: 405, headers },
    );
  const origin = new URL(request.url).origin;
  const requestOrigin = request.headers.get("origin");
  if (
    (requestOrigin && requestOrigin !== origin) ||
    (!requestOrigin && request.headers.get("sec-fetch-site") !== "same-origin")
  )
    return Response.json(
      superjson.serialize({
        ok: false,
        error: { code: "FORBIDDEN", message: "Same-origin request required" },
      }),
      { status: 403, headers },
    );
  try {
    const input = startOperationDispatchInput.parse(
      superjson.deserialize(superJsonResultSchema.parse(await request.json())),
    );
    const result = await dispatchStartOperation({
      ...input,
      request: { headers: request.headers, signal: request.signal },
    });
    return Response.json(superjson.serialize(result), { headers });
  } catch (error) {
    if (request.signal.aborted) throw error;
    const normalized = normalizeStartOperationError(
      error,
      "input",
      getRequestId(request.headers),
      {
        operation: "dispatch",
        authenticated: false,
        headers: request.headers,
      },
    );
    return Response.json(
      superjson.serialize({ ok: false, error: normalized.publicError }),
      { headers },
    );
  }
}
