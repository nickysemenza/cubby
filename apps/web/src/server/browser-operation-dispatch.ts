import superjson from "superjson";
import { z } from "zod";

import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import { settleBatch } from "~/server/settle-batch";
import { startOperationDispatchInput } from "~/server/start-operation-dispatch.contract";
import { dispatchStartOperation } from "~/server/start-operation-dispatch.server";
import { normalizeStartOperationError } from "~/server/start-operation.server";
import { getRequestId } from "~/server/tracing";

const batchBodySchema = z.object({ batch: z.array(z.unknown()) });

/** Concurrent reads a browser coalesced into one request; queries only. */
const startOperationDispatchBatch = z.object({
  batch: z
    .array(
      startOperationDispatchInput.refine(
        ({ operation }) =>
          startOperationDefinitionFor(operation)?.kind === "query",
        "Only queries can be batched",
      ),
    )
    .min(1)
    .max(20),
});

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
    const body = superjson.deserialize(
      superJsonResultSchema.parse(await request.json()),
    );
    // A body with `batch` is a batch: report its own validation issues rather
    // than falling through to the single-operation parser's misleading error.
    if (batchBodySchema.safeParse(body).success) {
      const batched = { data: startOperationDispatchBatch.parse(body) };
      // Each operation still authenticates and settles independently; the
      // batch shares only this isolate and its request-scoped database pool.
      // Results stream as NDJSON in finish order, so a fast read never waits
      // behind a slow sibling.
      const { readable, writable } = new TransformStream<Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      void settleBatch(
        batched.data.batch,
        async (input) => {
          try {
            return await dispatchStartOperation({
              ...input,
              request: { headers: request.headers, signal: request.signal },
            });
          } catch (error) {
            if (request.signal.aborted) throw error;
            return {
              ok: false as const,
              error: normalizeStartOperationError(
                error,
                "input",
                getRequestId(request.headers),
                {
                  operation: input.operation,
                  authenticated: false,
                  headers: request.headers,
                },
              ).publicError,
            };
          }
        },
        {
          concurrency: 4,
          onSettled: (index, result) =>
            void writer.write(
              encoder.encode(
                `${JSON.stringify({ i: index, r: superjson.serialize(result) })}\n`,
              ),
            ),
        },
      ).then(
        () => writer.close(),
        (error: Error) => writer.abort(error),
      );
      return new Response(readable, {
        headers: { ...headers, "content-type": "application/x-ndjson" },
      });
    }
    const input = startOperationDispatchInput.parse(body);
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
