/**
 * Shared event shape for server-side streaming bulk operations.
 *
 * A bulk workflow does all the work server-side in one request and yields these
 * events over a typed JSONL route. The client drains them with `useBulkStream`
 * (`for await`) to drive a progress bar.
 *
 * `Item` is an optional per-unit payload (e.g. which card succeeded/failed), so a
 * single stream can drive both an overall bar and per-row status. `Result` is the
 * final summary returned once the operation completes.
 */
export type BulkProgressEvent<Item = unknown, Result = unknown> =
  | { type: "progress"; done: number; total: number; item?: Item }
  | { type: "done"; result: Result };

/**
 * Drive a `{done,total}`-yielding generator (a repo/service that streams its own
 * progress) as a `BulkProgressEvent` stream from a workflow async generator.
 * Re-yields each tick as a `progress` event, then runs `finalize` on the generator's
 * return value (e.g. a post-loop recompute + shaping the summary) and yields `done`.
 */
export async function* streamProgress<R, Out>(
  gen: AsyncGenerator<{ done: number; total: number }, R>,
  finalize: (result: R) => Out | Promise<Out>,
): AsyncGenerator<BulkProgressEvent<never, Out>> {
  let next = await gen.next();
  while (!next.done) {
    yield { type: "progress", done: next.value.done, total: next.value.total };
    next = await gen.next();
  }
  yield { type: "done", result: await finalize(next.value) };
}

/**
 * Client-side: drain a streamed bulk mutation to its final summary, ignoring the
 * progress ticks.
 *
 * `useBulkStream` is the right tool when ONE stream drives a progress bar; it
 * holds single-run React state, so it can't sequence several runs. This is the
 * headless counterpart for a caller that runs streamed mutations back-to-back
 * and tracks progress at the task level instead (see the Problems auto-fix
 * runner). Rejects if the stream ends without a `done` event, so a truncated
 * stream can't read as a silent success.
 */
export async function collectBulkStream<Result>(
  iterable: AsyncIterable<BulkProgressEvent<unknown, Result>>,
): Promise<Result> {
  for await (const event of iterable) {
    if (event.type === "done") return event.result;
  }
  throw new Error("Bulk stream ended without a result");
}

/**
 * Drive a per-item loop as a `BulkProgressEvent` stream from a workflow. Owns the
 * boilerplate every streamed bulk loop
 * shares: an initial `{done:0,total}` tick, a per-item `progress` event, the
 * `succeeded`/`failed` tally, optional per-item error isolation, and the final
 * `done` event. Sibling to {@link streamProgress} (which drains a sub-generator;
 * this one drives a loop over an array).
 *
 * `step` does one item's work and optionally returns a per-item event payload
 * (`Item`); return `undefined`/`void` for progress-only items. Throwing aborts
 * the run unless `onError` is given, in which case the item is counted as failed
 * and the loop continues (and `onError`'s return becomes that item's payload).
 * `finalize` maps the run summary to the procedure's result and is the place for
 * any post-loop step (e.g. a single batched recompute); collect side-data
 * (inserted ids, failure details) in closures these callbacks capture.
 */
export async function* streamItems<
  T,
  Item = never,
  Result = { succeeded: number; failed: number },
>(
  items: readonly T[],
  // `| void` lets a no-payload step (an `async` fn with no return) be passed as-is.
  // A step may return a per-item payload or nothing.
  step: (item: T, index: number) => Promise<Item | void>,
  opts: {
    // onError may return a per-item payload or nothing.
    onError?: (item: T, index: number, error: unknown) => Item | void;
    finalize?: (summary: {
      succeeded: number;
      failed: number;
    }) => Result | Promise<Result>;
  } = {},
): AsyncGenerator<BulkProgressEvent<Item, Result>> {
  const total = items.length;
  let succeeded = 0;
  let failed = 0;
  yield { type: "progress", done: 0, total };
  for (let i = 0; i < items.length; i++) {
    const done = i + 1;
    // Inferred (not annotated) so the `| void` return type doesn't surface here.
    try {
      const item = await step(items[i]!, i);
      succeeded++;
      yield item === undefined
        ? { type: "progress", done, total }
        : { type: "progress", done, total, item };
    } catch (error) {
      if (!opts.onError) throw error;
      failed++;
      const item = opts.onError(items[i]!, i, error);
      yield item === undefined
        ? { type: "progress", done, total }
        : { type: "progress", done, total, item };
    }
  }
  const result = (
    opts.finalize
      ? await opts.finalize({ succeeded, failed })
      : { succeeded, failed }
  ) as Result;
  yield { type: "done", result };
}
