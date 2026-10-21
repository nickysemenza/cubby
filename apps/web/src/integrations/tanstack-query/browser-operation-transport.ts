import { type BatchResult, batchResultSchema } from "@cubby/schemas/batch";
import { retryWithBackoff } from "@cubby/shared/retry";
import superjson from "superjson";
import { z } from "zod";

import { createRequestBatcher } from "~/integrations/tanstack-query/request-batcher";
import { browserOperationPath } from "~/lib/browser-operation-path";
import { createConcurrencyLimiter } from "~/lib/concurrency-limiter";
import {
  describeErrorCauses,
  type ErrorDiagnostics,
  scrubErrorMessage,
} from "~/lib/error-diagnostics";
import { getAppErrorDetails } from "~/lib/error-utils";
import { fetchWithRequestDiagnostics } from "~/lib/request-id";
import {
  START_OPERATION_TRACE_HEADERS,
  type StartOperationId,
  startOperationDefinitionFor,
} from "~/lib/start-operation-observability";
import { superJsonResultSchema } from "~/lib/superjson-wire";
import {
  type StartOperationResult,
  type UnparsedStartOperationData,
  unparsedStartOperationResultSchema,
} from "~/server/operation-runtime/start-operation.contract";

type DispatchItem = {
  operation: StartOperationId;
  input: UnparsedStartOperationData;
};

type DispatchResult = StartOperationResult<UnparsedStartOperationData>;
type QueuedDispatchItem = { item: DispatchItem; headers: HeadersInit };

// One page can flush reads in separate tasks or header groups. Every query
// HTTP request, including singletons and fallback, shares the same budget.
const queryRequests = createConcurrencyLimiter(4);
// Jitter across browser tabs, while siblings in one failed stream keep the
// same delay so their retries can coalesce into another batch.
const databaseRetryJitterMs = Math.floor(Math.random() * 250);

function isTransientDatabaseFailure(result: DispatchResult): boolean {
  if (result.ok || result.error.code !== "INTERNAL_SERVER_ERROR") return false;
  const diagnostics = result.error.diagnostics;
  if (!diagnostics || !["context", "run"].includes(diagnostics.stage))
    return false;
  return diagnostics.causes.some(
    ({ code, message }) =>
      (code === "58000" && message.includes("open slot in the pool")) ||
      ["08000", "08003", "08006", "57P01", "57P02", "57P03"].includes(
        code ?? "",
      ) ||
      (!code && message === "Connection terminated unexpectedly"),
  );
}

/**
 * The batch could not answer this item (one queued alone, an HTTP failure, a
 * a broken or truncated
 * stream). The caller resends it alone, so it gets exactly the
 * single-operation result or error — request id, status, diagnostics — it
 * always had. Only queries batch, and they are safe to resend.
 */
class BatchFallback extends Error {
  constructor(cause?: unknown) {
    super("Browser operation batch fell back to single requests", { cause });
    this.name = "BatchFallback";
  }
}

const streamedLineSchema = z.object({
  i: z.number().int().nonnegative(),
  r: superJsonResultSchema,
});
const streamedResultSchema = batchResultSchema(
  unparsedStartOperationResultSchema,
);

const postInit = (
  body: DispatchItem | { batch: DispatchItem[] },
  headersInit: HeadersInit,
  signal: AbortSignal | undefined,
): RequestInit => {
  const headers = new Headers(headersInit);
  headers.set("content-type", "application/json");
  return {
    method: "POST",
    headers,
    credentials: "same-origin",
    body: JSON.stringify(superjson.serialize(body)),
    signal,
  };
};

function protocolFailure(
  response: Response,
  operation: string,
  started: number,
  body: string | undefined,
  cause: unknown,
) {
  const message = scrubErrorMessage(
    `${operation} returned an invalid response (HTTP ${response.status}): ${body ?? "response body could not be read"}`,
  );
  return Object.assign(new Error(message, { cause }), {
    data: {
      code: "INVALID_TRANSPORT_RESPONSE",
      requestId:
        response.headers.get("x-request-id") ??
        response.headers.get("cf-ray") ??
        undefined,
      diagnostics: {
        origin: "server",
        operation,
        stage: "output",
        ...describeErrorCauses(cause, { includeStacks: true }),
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
  });
}

/** POST one operation (a mutation, or any call outside a batch). */
async function postDispatch(
  item: DispatchItem,
  headersInit: HeadersInit,
  signal: AbortSignal | undefined,
): Promise<DispatchResult> {
  const started = performance.now();
  const response = await fetchWithRequestDiagnostics(
    fetch,
    browserOperationPath(item.operation),
    postInit(item, headersInit, signal),
    { operation: item.operation },
  );
  let body: string | undefined;
  try {
    body = await response.text();
    const json: unknown = JSON.parse(body);
    const parsed = superJsonResultSchema.parse(json);
    return unparsedStartOperationResultSchema.parse(
      superjson.deserialize(parsed),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw protocolFailure(response, item.operation, started, body, error);
  }
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
  const response = await fetchWithRequestDiagnostics(
    fetch,
    browserOperationPath(batch.map(({ operation }) => operation)),
    postInit({ batch }, headersInit, signal),
    { operation },
  );
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("application/x-ndjson")
  ) {
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
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const answered = new Set<number>();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // A Worker stream can end cleanly before every item settles (observed: an
      // empty HTTP 200 body). Answered siblings keep their results; the rest
      // fall back to single requests instead of rejecting as omitted.
      if (done) {
        if (answered.size < batch.length)
          throw protocolFailure(
            response,
            operation,
            started,
            buffered,
            new Error(
              `Batch stream ended with ${answered.size} of ${batch.length} results`,
            ),
          );
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
        if (!line) continue;
        try {
          const { i, r } = streamedLineSchema.parse(JSON.parse(line));
          if (i >= batch.length || answered.has(i))
            throw new Error(`Unexpected batch result index ${i}`);
          deliver(i, streamedResultSchema.parse(superjson.deserialize(r)));
          answered.add(i);
        } catch (error) {
          throw protocolFailure(response, operation, started, line, error);
        }
      }
    }
  } catch (error) {
    if (
      signal.aborted ||
      getAppErrorDetails(error).code === "INVALID_TRANSPORT_RESPONSE"
    )
      throw error;
    throw protocolFailure(response, operation, started, buffered, error);
  } finally {
    await reader.cancel().catch(() => {
      // SILENT: cleanup must not replace the original stream/protocol failure.
    });
    reader.releaseLock();
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
    .filter(([name]) => !START_OPERATION_TRACE_HEADERS.includes(name))
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
          queryRequests.run(() => postDispatch(item, headers, signal), signal),
      },
    );
    queryBatchers.set(key, batcher);
  }
  return batcher;
}

/** Use the same operation envelope as Start without importing its React handler. */
export async function dispatchBrowserOperation(
  operation: StartOperationId,
  input: UnparsedStartOperationData,
  transport: { signal?: AbortSignal; headers: HeadersInit; batch?: boolean },
): Promise<DispatchResult> {
  if (startOperationDefinitionFor(operation)?.kind === "query") {
    const signal = transport.signal ?? new AbortController().signal;
    const retries: NonNullable<ErrorDiagnostics["retries"]> = [];
    const remember = (error: unknown) => {
      const detail = getAppErrorDetails(error);
      retries.push({
        attempt: retries.length + 1,
        message: detail.message,
        code: detail.code,
        requestId: detail.requestId,
        diagnostics: detail.diagnostics,
      });
    };
    const diagnosticsFor = (error: unknown): ErrorDiagnostics => {
      const detail = getAppErrorDetails(error);
      return {
        origin: "server",
        operation,
        stage: "http",
        ...describeErrorCauses(error, { includeStacks: true }),
        ...detail.diagnostics,
        retries,
      };
    };
    // Query declarations already permit replay after a broken batch. Retry
    // only explicit transient database diagnostics, on a fresh request scope;
    // a partial write must never enter this recovery path.
    const retry = retryWithBackoff(
      async () => {
        signal.throwIfAborted();
        if (transport.batch !== false) {
          try {
            return await queryBatcherFor(transport.headers).load(
              { item: { operation, input }, headers: transport.headers },
              signal,
            );
          } catch (error) {
            if (!(error instanceof BatchFallback)) throw error;
            remember(error.cause ?? error);
          }
        }
        return queryRequests.run(
          () => postDispatch({ operation, input }, transport.headers, signal),
          signal,
        );
      },
      {
        signal,
        delayFor: (outcome, attempt) => {
          if (
            attempt >= 2 ||
            !outcome.ok ||
            outcome.value.ok ||
            !isTransientDatabaseFailure(outcome.value)
          )
            return null;
          remember({
            message: outcome.value.error.message,
            data: outcome.value.error,
          });
          return 250 * 2 ** attempt + databaseRetryJitterMs;
        },
      },
    );
    try {
      const result = await retry;
      if (!result.ok && retries.length) {
        result.error.diagnostics = diagnosticsFor({
          message: result.error.message,
          data: result.error,
        });
      }
      return result;
    } catch (error) {
      if (!retries.length || signal.aborted) throw error;
      const detail = getAppErrorDetails(error);
      throw Object.assign(new Error(detail.message, { cause: error }), {
        data: { ...detail, diagnostics: diagnosticsFor(error) },
      });
    }
  }
  return postDispatch(
    { operation, input },
    transport.headers,
    transport.signal,
  );
}
