import type { BatchOut, BatchResult } from "@cubby/schemas/batch";

import { createConcurrencyLimiter } from "./concurrency-limiter";
import type { UnparsedError } from "./error-utils";

/**
 * Send one batch. Either return every result at once, or stream them through
 * `deliver(index, result)` as they arrive (and return nothing); items neither
 * returned nor delivered reject once the promise settles.
 */
type SendBatch<TInput, TOutput> = (
  items: TInput[],
  signal: AbortSignal,
  deliver: (index: number, result: BatchResult<TOutput>) => void,
) => Promise<BatchOut<TOutput> | void>;

type Pending<TInput, TOutput> = {
  input: TInput;
  signal: AbortSignal;
  resolve: (value: TOutput) => void;
  reject: (reason: UnparsedError) => void;
};

const abortError = () => new DOMException("Request cancelled", "AbortError");

/**
 * Coalesce many single-item calls into batched requests. Callers keep their
 * own per-item query (and cache entry); only transport is shared. Items
 * requested in the same task ride one request of at most `max` items, at most
 * `concurrency` requests run at once, and a request is aborted only once every
 * item in it has been cancelled.
 *
 * The send function returns positional `BatchOut` results (see
 * `@cubby/schemas/batch`); a failed result rejects only its own item.
 */
export function createRequestBatcher<TInput, TOutput>(
  send: SendBatch<TInput, TOutput>,
  {
    max = 25,
    concurrency = 2,
    sendOne,
  }: {
    max?: number;
    concurrency?: number;
    /**
     * Send an item that flushed alone. It skips the limiter: batching buys a
     * lone item nothing, and queueing it behind slow full batches stalls it.
     */
    sendOne?: (input: TInput, signal: AbortSignal) => Promise<TOutput>;
  } = {},
) {
  const limiter = createConcurrencyLimiter(concurrency);
  let queued: Pending<TInput, TOutput>[] = [];
  let scheduled = false;

  const dispatch = (batch: Pending<TInput, TOutput>[]) => {
    const [lone] = batch;
    if (sendOne && lone && batch.length === 1) {
      sendOne(lone.input, lone.signal).then(lone.resolve, lone.reject);
      return;
    }
    const controller = new AbortController();
    const onItemAbort = () => {
      if (batch.every((entry) => entry.signal.aborted)) controller.abort();
    };
    for (const entry of batch)
      entry.signal.addEventListener("abort", onItemAbort, { once: true });
    const settle = (
      entry: Pending<TInput, TOutput>,
      result: BatchResult<TOutput>,
    ) => {
      if (result.ok) entry.resolve(result.value);
      else entry.reject(new Error(result.message));
    };
    const deliver = (index: number, result: BatchResult<TOutput>) => {
      const entry = batch[index];
      if (entry) settle(entry, result);
    };
    limiter
      .run(
        () =>
          send(
            batch.map((entry) => entry.input),
            controller.signal,
            deliver,
          ),
        controller.signal,
      )
      .then(
        (out) => {
          out?.results.forEach((result, index) => deliver(index, result));
          // Settlement is idempotent: this only reaches items never answered.
          for (const entry of batch)
            entry.reject(new Error("Batch omitted this item"));
        },
        (error: UnparsedError) => batch.forEach((entry) => entry.reject(error)),
      )
      .finally(() => {
        for (const entry of batch)
          entry.signal.removeEventListener("abort", onItemAbort);
      });
  };

  const flush = () => {
    scheduled = false;
    const live = queued.filter((entry) => !entry.signal.aborted);
    queued = [];
    for (let start = 0; start < live.length; start += max)
      dispatch(live.slice(start, start + max));
  };

  return {
    load(input: TInput, signal: AbortSignal): Promise<TOutput> {
      return new Promise<TOutput>((resolve, reject) => {
        if (signal.aborted) {
          reject(abortError());
          return;
        }
        // Promise settlement is idempotent, so a late abort after resolve
        // (or a result after abort) is a no-op.
        signal.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
        queued.push({ input, signal, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          // A macrotask, not a microtask: React Query starts each item's
          // queryFn from separate effects within one commit, so a microtask
          // would flush after the first item alone.
          setTimeout(flush, 0);
        }
      });
    },
  };
}
