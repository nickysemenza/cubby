import { type BatchResult, batchResultSchema } from "@cubby/schemas/batch";
import superjson from "superjson";
import { z } from "zod";

import { BROWSER_OPERATION_PATH } from "~/lib/browser-operation-path";
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
        await streamDispatch(batch, entries, signal, deliver).catch(
          (error: Error) => {
            if (signal.aborted) throw error;
            throw new BatchFallback();
          },
        );
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
    try {
      return await queryBatcherFor(transport.headers).load(
        { operation, input },
        transport.signal ?? new AbortController().signal,
      );
    } catch (error) {
      if (!(error instanceof BatchFallback)) throw error;
    }
  }
  return postDispatch(
    { operation, input },
    transport.headers,
    transport.signal,
  );
}
