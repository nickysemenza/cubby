import { type BatchResult, batchResultSchema } from "@cubby/schemas/batch";
import { retryWithBackoff } from "@cubby/shared/retry";
import superjson from "superjson";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
import { createConcurrencyLimiter } from "~/lib/concurrency-limiter";
import { createRequestBatcher } from "~/lib/request-batcher";
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
} from "~/server/start-operation.contract";

type DispatchItem = {
  operation: StartOperationId;
  input: UnparsedStartOperationData;
};

type DispatchResult = StartOperationResult<UnparsedStartOperationData>;

// One page can flush reads in separate tasks or header groups. Every query
// HTTP request, including singletons and fallback, shares the same budget.
const queryRequests = createConcurrencyLimiter(4);

function isTransientDatabaseFailure(result: DispatchResult): boolean {
  if (result.ok || result.error.code !== "INTERNAL_SERVER_ERROR") return false;
  const diagnostics = result.error.diagnostics;
  if (!diagnostics || !["context", "run"].includes(diagnostics.stage))
    return false;
  return diagnostics.causes.some(
    ({ code, message }) =>
      (code === "58000" &&
        message === "Timed out while waiting for an open slot in the pool.") ||
      ["08000", "08003", "08006", "57P01", "57P02", "57P03"].includes(
        code ?? "",
      ) ||
      (!code && message === "Connection terminated unexpectedly"),
  );
}

/**
 * The batch could not answer this item (one queued alone, an HTTP failure, a
 * server without batch support during a deploy, a broken stream). The caller
 * resends it alone, so it gets exactly the single-operation result or error —
 * request id, status, diagnostics — it always had. Only queries batch, and
 * they are safe to resend.
 */
class BatchFallback extends Error {
  constructor() {
    super("Browser operation batch fell back to single requests");
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

/** POST one operation (a mutation, or any call outside a batch). */
async function postDispatch(
  item: DispatchItem,
  headersInit: HeadersInit,
  signal: AbortSignal | undefined,
): Promise<DispatchResult> {
  const response = await fetchWithRequestDiagnostics(
    fetch,
    BROWSER_OPERATION_PATH,
    postInit(item, headersInit, signal),
  );
  const json: unknown = await response.json();
  const parsed = superJsonResultSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Browser operation dispatch returned HTTP ${response.status}: ${JSON.stringify(json)}`,
      { cause: parsed.error },
    );
  }
  return unparsedStartOperationResultSchema.parse(
    superjson.deserialize(parsed.data),
  );
}

/** POST a batch and deliver each NDJSON result line as the server settles it. */
async function streamDispatch(
  batch: DispatchItem[],
  headersInit: HeadersInit,
  signal: AbortSignal,
  deliver: (index: number, result: BatchResult<DispatchResult>) => void,
): Promise<void> {
  const response = await fetchWithRequestDiagnostics(
    fetch,
    BROWSER_OPERATION_PATH,
    postInit({ batch }, headersInit, signal),
  );
  if (
    !response.ok ||
    !response.body ||
    !response.headers.get("content-type")?.includes("application/x-ndjson")
  ) {
    throw new BatchFallback();
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffered += value;
    for (
      let newline = buffered.indexOf("\n");
      newline !== -1;
      newline = buffered.indexOf("\n")
    ) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const { i, r } = streamedLineSchema.parse(JSON.parse(line));
      deliver(i, streamedResultSchema.parse(superjson.deserialize(r)));
    }
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
  ReturnType<typeof createRequestBatcher<DispatchItem, DispatchResult>>
>();

function queryBatcherFor(headers: HeadersInit) {
  const entries = [...new Headers(headers).entries()]
    .filter(([name]) => !START_OPERATION_TRACE_HEADERS.includes(name))
    .sort();
  const key = JSON.stringify(entries);
  let batcher = queryBatchers.get(key);
  if (!batcher) {
    batcher = createRequestBatcher(
      async (batch: DispatchItem[], signal, deliver) => {
        await queryRequests
          .run(() => streamDispatch(batch, entries, signal, deliver), signal)
          .catch((error: Error) => {
            if (signal.aborted) throw error;
            throw new BatchFallback();
          });
      },
      {
        max: 20,
        concurrency: 4,
        // The caller resends it with its own trace headers.
        sendOne: () => Promise.reject(new BatchFallback()),
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
  transport: { signal?: AbortSignal; headers: HeadersInit },
): Promise<DispatchResult> {
  if (startOperationDefinitionFor(operation)?.kind === "query") {
    const signal = transport.signal ?? new AbortController().signal;
    // Query declarations already permit replay after a broken batch. Retry
    // only explicit transient database diagnostics, on a fresh request scope;
    // a partial write must never enter this recovery path.
    return retryWithBackoff(
      async () => {
        signal.throwIfAborted();
        try {
          return await queryBatcherFor(transport.headers).load(
            { operation, input },
            signal,
          );
        } catch (error) {
          if (!(error instanceof BatchFallback)) throw error;
        }
        return queryRequests.run(
          () => postDispatch({ operation, input }, transport.headers, signal),
          signal,
        );
      },
      {
        signal,
        delayFor: (outcome, attempt) =>
          attempt < 2 && outcome.ok && isTransientDatabaseFailure(outcome.value)
            ? 250 * 2 ** attempt + Math.floor(Math.random() * 250)
            : null,
      },
    );
  }
  return postDispatch(
    { operation, input },
    transport.headers,
    transport.signal,
  );
}
