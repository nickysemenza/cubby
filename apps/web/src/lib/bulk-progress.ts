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
