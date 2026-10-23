import superjson from "superjson";
import { z } from "zod";

import { browserOperationPath } from "~/lib/browser-operation-path";
import { startOperationDefinitionFor } from "~/lib/start-operation-observability";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import {
  authenticate,
  BROWSER_AUTH,
  type Challenge,
  challengeError,
  isChallenge,
  type Principal,
} from "~/server/http/authenticate";
import { getRequestId } from "~/server/observability/tracing";
import { startOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import type { StartOperationDispatchInput } from "~/server/operation-runtime/start-operation-dispatch.contract";
import { dispatchStartOperation } from "~/server/operation-runtime/start-operation-dispatch.server";
import { normalizeStartOperationError } from "~/server/operation-runtime/start-operation.server";
import { settleBatch } from "~/server/workflows/settle-batch";

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

/**
 * One operation under the request's principal; without one, the same
 * unauthenticated failure every operation in the request reports.
 */
export async function dispatchAs(
  authenticated: Principal | Challenge,
  input: StartOperationDispatchInput,
  request: Request,
) {
  if (!isChallenge(authenticated))
    return dispatchStartOperation({
      ...input,
      request: {
        principal: authenticated,
        headers: request.headers,
        signal: request.signal,
      },
    });
  return {
    ok: false as const,
    error: normalizeStartOperationError(
      challengeError(authenticated),
      "context",
      getRequestId(request.headers),
      {
        operation: input.operation,
        authenticated: false,
        headers: request.headers,
      },
    ).publicError,
  };
}

export async function handleBrowserOperationDispatch(
  request: Request,
): Promise<Response> {
  const headers = new Headers({ "cache-control": "no-store" });
  if (request.method !== "POST")
    return Response.json(
      superjson.serialize({
        ok: false,
        error: { code: "METHOD_NOT_ALLOWED", message: "POST required" },
      }),
      { status: 405, headers },
    );
  try {
    const authenticated = await authenticate(request, BROWSER_AUTH);
    if (isChallenge(authenticated) && authenticated.status === 403)
      return Response.json(
        superjson.serialize({
          ok: false,
          error: { code: authenticated.code, message: authenticated.message },
        }),
        { status: 403, headers },
      );
    if (!isChallenge(authenticated))
      for (const [name, value] of authenticated.responseHeaders)
        headers.append(name, value);
    const body = superjson.deserialize(
      superJsonResultSchema.parse(await request.json()),
    );
    // A body with `batch` is a batch: report its own validation issues rather
    // than falling through to the single-operation parser's misleading error.
    if (batchBodySchema.safeParse(body).success) {
      const batched = { data: startOperationDispatchBatch.parse(body) };
      z.literal(
        browserOperationPath(
          batched.data.batch.map(({ operation }) => operation),
        ),
      ).parse(new URL(request.url).pathname);
      // The request authenticated once; each operation still settles
      // independently, sharing this isolate and its request-scoped pool.
      // Results stream as NDJSON in finish order, so a fast read never waits
      // behind a slow sibling.
      const { readable, writable } = new TransformStream<Uint8Array>();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      void settleBatch(
        batched.data.batch,
        async (input) => {
          try {
            return await dispatchAs(authenticated, input, request);
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
      headers.set("content-type", "application/x-ndjson");
      return new Response(readable, { headers });
    }
    const input = startOperationDispatchInput.parse(body);
    z.literal(browserOperationPath(input.operation)).parse(
      new URL(request.url).pathname,
    );
    const result = await dispatchAs(authenticated, input, request);
    // The hosted native workspace turns a 426 into its update prompt; the
    // envelope is the same `{ ok: false }` body every refusal carries.
    return Response.json(superjson.serialize(result), {
      status:
        !result.ok && result.error.code === "UPGRADE_REQUIRED" ? 426 : 200,
      headers,
    });
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
