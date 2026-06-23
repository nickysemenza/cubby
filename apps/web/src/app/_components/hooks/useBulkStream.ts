import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { getErrorMessage } from "~/lib/error-utils";

interface BulkStreamState<Result> {
  /** Latest `{ done, total }`, or null before the first event. */
  progress: { done: number; total: number } | null;
  running: boolean;
  error: string | null;
  /** Final summary, available once the stream completes. */
  result: Result | null;
}

interface BulkStreamHandlers<Item, Result> {
  /** Fired for each progress event that carries a per-item payload (e.g. a row outcome). */
  onItem?: (item: Item) => void;
  /** Fired on every progress tick with the running counts. */
  onProgress?: (done: number, total: number) => void;
  /** Fired once with the final summary when the stream completes. */
  onDone?: (result: Result) => void;
  /** Success-toast text built from the final summary; return null/"" to skip the toast. */
  successToast?: (result: Result) => string | null;
}

/**
 * Drives a server-side streaming bulk operation — a tRPC async-generator
 * procedure (`.query(async function* …)` yielding {@link BulkProgressEvent}s over
 * `httpBatchStreamLink`) — into progress-bar state. The work runs server-side in
 * ONE request; this hook just consumes the stream. Generalizes `useAgentStream`.
 *
 * Usage (handlers are per-`start`, so they can close over per-invocation context):
 * ```ts
 * const bulk = useBulkStream<Item, Result>();
 * bulk.start(() => client.recipe.importCookbookStream.query(input), {
 *   onItem, onProgress, successToast,
 * });
 * ```
 * Uses the vanilla tRPC client (React Query hooks don't expose the incremental
 * generator). A monotonic run id supersedes any in-flight stream on restart/reset.
 */
export function useBulkStream<Item = unknown, Result = unknown>() {
  const [state, setState] = useState<BulkStreamState<Result>>({
    progress: null,
    running: false,
    error: null,
    result: null,
  });
  const runIdRef = useRef(0);

  const reset = useCallback(() => {
    runIdRef.current++;
    setState({ progress: null, running: false, error: null, result: null });
  }, []);

  const start = useCallback(
    async (
      open: () => Promise<AsyncIterable<BulkProgressEvent<Item, Result>>>,
      handlers: BulkStreamHandlers<Item, Result> = {},
    ) => {
      const runId = ++runIdRef.current;
      setState({ progress: null, running: true, error: null, result: null });
      try {
        const iterable = await open();
        for await (const event of iterable) {
          if (runIdRef.current !== runId) return; // superseded by a newer run/reset
          if (event.type === "progress") {
            setState((s) => ({
              ...s,
              progress: { done: event.done, total: event.total },
            }));
            handlers.onProgress?.(event.done, event.total);
            if (event.item !== undefined) handlers.onItem?.(event.item);
          } else {
            setState((s) => ({ ...s, running: false, result: event.result }));
            handlers.onDone?.(event.result);
            const msg = handlers.successToast?.(event.result);
            if (msg) toast.success(msg);
          }
        }
      } catch (error) {
        if (runIdRef.current === runId) {
          const message = getErrorMessage(error);
          setState((s) => ({ ...s, running: false, error: message }));
          toast.error(message);
        }
      }
    },
    [],
  );

  return { ...state, start, reset };
}
