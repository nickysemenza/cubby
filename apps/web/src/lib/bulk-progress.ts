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
