import { type BatchResult, batchResultSchema } from "@cubby/schemas/batch";
import { z } from "zod";

import { createRequestBatcher } from "~/integrations/tanstack-query/request-batcher";
import { browserOperationPath } from "~/lib/browser-operation-path";
import { createConcurrencyLimiter } from "~/lib/concurrency-limiter";
import {
  describeErrorCauses,
  type ErrorDiagnostics,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import { OperationError } from "~/lib/operation-error";
import {
  OPERATION_TRACE_HEADERS,
  type OperationId,
  operationDefinitionFor,
} from "~/lib/operation-observability";
import { recordResponse } from "~/lib/request-id";
import {
  publicOperationErrorSchema,
  type OperationResult,
  type OperationWireValue,
  operationResultSchema,
} from "~/server/operation-runtime/operation.contract";

type DispatchItem = {
  operation: OperationId;
  input: OperationWireValue;
};

type DispatchResult = OperationResult<OperationWireValue>;
type QueuedDispatchItem = { item: DispatchItem; headers: HeadersInit };

export type OperationTransportOptions = {
  signal?: AbortSignal;
  headers: HeadersInit;
  batch?: boolean;
};

/** How a request reaches `/api/operations`; SSR answers it in process. */
export type OperationFetch = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

const browserFetch: OperationFetch = (url, init) => fetch(url, init);

// One page can flush reads in separate tasks or header groups. Every query
// HTTP request, including singletons and fallback, shares the same budget.
const queryRequests = createConcurrencyLimiter(4);

/**
 * The batch could not answer this item (one queued alone, an HTTP failure, a
 * broken or truncated stream). The caller resends it alone, so it gets
 * exactly the single-operation result or error — request id, status,
 * diagnostics — it always had. Only queries batch, and they are safe to
 * resend.
 */
class BatchFallback extends Error {
  constructor(cause?: Error) {
    super("Browser operation batch fell back to single requests", { cause });
    this.name = "BatchFallback";
  }
}

const batchLineSchema = z.object({
  i: z.number().int().nonnegative(),
  r: batchResultSchema(operationResultSchema),
});

const postInit = (
  body: DispatchItem | { batch: DispatchItem[] },
  headersInit: HeadersInit,
  signal: AbortSignal | undefined,
): RequestInit => {
  const headers = new Headers(headersInit);
  headers.set("content-type", "application/json");
  // Browser auth (the `web` audit channel), internal operations and streams.
  headers.set("x-cubby-surface", "browser");
  return { method: "POST", headers, body: JSON.stringify(body), signal };
};

const isNdjson = (response: Response) =>
  response.headers.get("content-type")?.includes("application/x-ndjson") ??
  false;

const requestIdOf = (response: Response) =>
  response.headers.get("x-request-id") ??
  response.headers.get("cf-ray") ??
  undefined;

function protocolFailure<TCause>(
  response: Response,
  operation: string,
  started: number,
  body: string | undefined,
  cause: TCause,
): OperationError {
  const causes = describeErrorCauses(cause, { includeStacks: true });
  const message = scrubErrorMessage(
    `${operation} returned an invalid response (HTTP ${response.status}): ${body ?? causes.causes.at(-1)?.message ?? "response body could not be read"}`,
  );
  return new OperationError(
    {
      code: "INVALID_TRANSPORT_RESPONSE",
      message,
      requestId: requestIdOf(response),
      diagnostics: {
        origin: "server",
        operation,
        stage: "output",
        ...causes,
        http: {
          status: response.status,
          statusText: response.statusText,
          contentType: response.headers.get("content-type") ?? undefined,
          url: response.url || browserOperationPath(operation),
          body: body === undefined ? undefined : scrubErrorMessage(body),
          elapsedMs: performance.now() - started,
        },
      } satisfies ErrorDiagnostics,
    },
    { cause },
  );
}

/** Send one request; a network failure carries its HTTP diagnostics. */
async function send(
  fetchImpl: OperationFetch,
  url: string,
  init: RequestInit,
  operation: string,
  started: number,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new OperationError(
      {
        code: "NETWORK_ERROR",
        message: scrubErrorMessage(
          error instanceof Error ? error.message : String(error),
        ),
        diagnostics: {
          origin: "server",
          operation,
          stage: "http",
          ...describeErrorCauses(error, { includeStacks: true }),
          http: { url, elapsedMs: performance.now() - started },
        },
      },
      { cause: error },
    );
  }
  recordResponse(response, operation);
  return response;
}

/** The one envelope parse: success is `{ ok }`, a refusal the bare error under its status. */
async function readResult(
  response: Response,
  operation: string,
  started: number,
  signal: AbortSignal | undefined,
): Promise<DispatchResult> {
  let body: string | undefined;
  try {
    body = await response.text();
    const json: unknown = JSON.parse(body);
    if (response.ok) return operationResultSchema.parse(json);
    return { ok: false, error: publicOperationErrorSchema.parse(json) };
  } catch (error) {
    if (signal?.aborted) throw error;
    throw protocolFailure(response, operation, started, body, error);
  }
}

/** Each newline-terminated line; a body that ends inside a line is truncated. */
async function* ndjsonLines(body: ReadableStream<Uint8Array<ArrayBuffer>>) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffered) throw new Error("Stream ended inside a line");
        return;
      }
      buffered += value;
      for (
        let newline = buffered.indexOf("\n");
        newline !== -1;
        newline = buffered.indexOf("\n")
      ) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line) yield line;
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      // SILENT: cleanup must not replace the original stream/protocol failure.
    });
    reader.releaseLock();
  }
}

/** POST one operation (a mutation, or any call outside a batch). */
export async function postOperation(
  item: DispatchItem,
  headersInit: HeadersInit,
  signal: AbortSignal | undefined,
  fetchImpl: OperationFetch = browserFetch,
): Promise<DispatchResult> {
  const started = performance.now();
  const response = await send(
    fetchImpl,
    browserOperationPath(item.operation),
    postInit(item, headersInit, signal),
    item.operation,
    started,
  );
  return readResult(response, item.operation, started, signal);
}

/**
 * POST a workflow stream and yield each NDJSON result envelope as the server
 * settles it. A refusal before the stream starts yields its one result.
 */
export async function streamOperation(
  item: DispatchItem,
  headersInit: HeadersInit,
  signal: AbortSignal,
): Promise<AsyncIterable<DispatchResult>> {
  const started = performance.now();
  const response = await send(
    browserFetch,
    browserOperationPath(item.operation),
    postInit(item, headersInit, signal),
    item.operation,
    started,
  );
  const { body } = response;
  if (!response.ok || !body || !isNdjson(response)) {
    const result = await readResult(response, item.operation, started, signal);
    return (async function* () {
      yield result;
    })();
  }
  return (async function* () {
    let line: string | undefined;
    try {
      for await (const next of ndjsonLines(body)) {
        line = next;
        yield operationResultSchema.parse(JSON.parse(next));
      }
    } catch (error) {
      if (signal.aborted) throw error;
      throw protocolFailure(response, item.operation, started, line, error);
    }
  })();
}

/** POST a batch and deliver each NDJSON result line as the server settles it. */
async function streamDispatch(
  batch: DispatchItem[],
  headersInit: HeadersInit,
  signal: AbortSignal,
  deliver: (index: number, result: BatchResult<DispatchResult>) => void,
): Promise<void> {
  const started = performance.now();
  const operation = batch.map(({ operation }) => operation).join(", ");
  const response = await send(
    browserFetch,
    browserOperationPath(batch.map(({ operation }) => operation)),
    postInit({ batch }, headersInit, signal),
    operation,
    started,
  );
  if (!response.ok || !response.body || !isNdjson(response)) {
    let body: string;
    try {
      body = await response.text();
    } catch (error) {
      if (signal.aborted) throw error;
      throw protocolFailure(response, operation, started, undefined, error);
    }
    throw protocolFailure(
      response,
      operation,
      started,
      body,
      new Error("Expected an NDJSON batch response"),
    );
  }
  const answered = new Set<number>();
  let line: string | undefined;
  try {
    for await (const next of ndjsonLines(response.body)) {
      line = next;
      const { i, r } = batchLineSchema.parse(JSON.parse(next));
      if (i >= batch.length || answered.has(i))
        throw new Error(`Unexpected batch result index ${i}`);
      deliver(i, r);
      answered.add(i);
    }
    line = undefined;
    // A Worker stream can end cleanly before every item settles (observed: an
    // empty HTTP 200 body). Answered siblings keep their results; the rest
    // fall back to single requests instead of rejecting as omitted.
    if (answered.size < batch.length)
      throw new Error(
        `Batch stream ended with ${answered.size} of ${batch.length} results`,
      );
  } catch (error) {
    if (signal.aborted) throw error;
    throw protocolFailure(response, operation, started, line, error);
  }
}

/**
 * Reads issued in the same task share one Worker request. A page's related
 * tables, previews and image lookups used to open ~35 concurrent requests;
 * Cloudflare spread them over fresh isolates, and each paid a cold start plus
 * its own Hyperdrive connect (0.7–0.9 s) before a 20 ms query. Batches are
 * keyed by headers minus the per-operation trace headers (the body names each
 * operation), so a request's headers still describe every operation in it.
 */
const queryBatchers = new Map<
  string,
  ReturnType<typeof createRequestBatcher<QueuedDispatchItem, DispatchResult>>
>();

function queryBatcherFor(headers: HeadersInit) {
  const entries = [...new Headers(headers).entries()]
    .filter(([name]) => !OPERATION_TRACE_HEADERS.includes(name))
    .sort();
  const key = JSON.stringify(entries);
  let batcher = queryBatchers.get(key);
  if (!batcher) {
    batcher = createRequestBatcher(
      async (batch: QueuedDispatchItem[], signal, deliver) => {
        await queryRequests
          .run(
            () =>
              streamDispatch(
                batch.map(({ item }) => item),
                entries,
                signal,
                deliver,
              ),
            signal,
          )
          .catch((error: Error) => {
            if (signal.aborted) throw error;
            throw new BatchFallback(error);
          });
      },
      {
        max: 20,
        concurrency: 4,
        sendOne: ({ item, headers }, signal) =>
          queryRequests.run(() => postOperation(item, headers, signal), signal),
      },
    );
    queryBatchers.set(key, batcher);
  }
  return batcher;
}

/** Batch reads where possible; a mutation or a fallen-back read posts alone. */
export async function dispatchBrowserOperation(
  operation: OperationId,
  input: OperationWireValue,
  transport: OperationTransportOptions,
): Promise<DispatchResult> {
  const item = { operation, input };
  if (operationDefinitionFor(operation)?.kind !== "query")
    return postOperation(item, transport.headers, transport.signal);
  const signal = transport.signal ?? new AbortController().signal;
  if (transport.batch !== false) {
    try {
      return await queryBatcherFor(transport.headers).load(
        { item, headers: transport.headers },
        signal,
      );
    } catch (error) {
      if (!(error instanceof BatchFallback)) throw error;
    }
  }
  return queryRequests.run(
    () => postOperation(item, transport.headers, signal),
    signal,
  );
}
