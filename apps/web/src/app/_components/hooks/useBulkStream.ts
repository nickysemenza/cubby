import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { showErrorToast } from "~/components/feedback/error-details";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { getErrorMessage, type UnparsedError } from "~/lib/error-utils";

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
  /** Error-toast text; defaults to `getErrorMessage(error)`. */
  errorToast?: (error: UnparsedError) => string;
}

/**
 * Drives a server-side JSONL workflow stream (`async function*` yielding
 * {@link BulkProgressEvent}s) into progress-bar state. The work runs server-side
 * in one request; this hook just consumes the stream.
 *
 * Usage (handlers are per-`start`, so they can close over per-invocation context):
 * ```ts
 * const bulk = useBulkStream<Item, Result>();
 * bulk.start((signal) => openWorkflowStream({ signal, ... }), {
 *   onItem, onProgress, successToast,
 * });
 * ```
 * A monotonic run id supersedes and aborts any in-flight stream on restart/reset.
 */
export function useBulkStream<Item = unknown, Result = unknown>() {
  const [state, setState] = useState<BulkStreamState<Result>>({
    progress: null,
    running: false,
    error: null,
    result: null,
  });
  const runIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    runIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    setState({ progress: null, running: false, error: null, result: null });
  }, []);

  const start = useCallback(
    async (
      open: (
        signal: AbortSignal,
      ) => Promise<AsyncIterable<BulkProgressEvent<Item, Result>>>,
      handlers: BulkStreamHandlers<Item, Result> = {},
    ) => {
      const runId = ++runIdRef.current;
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setState({ progress: null, running: true, error: null, result: null });
      try {
        const iterable = await open(controller.signal);
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
            if (abortRef.current === controller) abortRef.current = null;
            setState((s) => ({ ...s, running: false, result: event.result }));
            handlers.onDone?.(event.result);
            const msg = handlers.successToast?.(event.result);
            if (msg) toast.success(msg);
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (runIdRef.current === runId) {
          const customMessage = handlers.errorToast?.(error);
          const message = customMessage ?? getErrorMessage(error);
          setState((s) => ({ ...s, running: false, error: message }));
          showErrorToast(error, customMessage);
        }
      }
    },
    [],
  );

  return { ...state, start, reset };
}
