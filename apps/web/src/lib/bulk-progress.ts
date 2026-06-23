/**
 * Shared event shape for server-side streaming bulk operations.
 *
 * A bulk procedure is a tRPC async generator (`.query(async function* …)`) that
 * does all the work server-side in ONE request and `yield`s these events over
 * `httpBatchStreamLink` — no SSE/subscription infra, works on CF Workers. The
 * client drains them with `useBulkStream` (`for await`) to drive a progress bar.
 * Mirrors the `agent.askStream` pattern.
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
 * progress) as a `BulkProgressEvent` stream from a tRPC `.mutation(async function*)`.
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
