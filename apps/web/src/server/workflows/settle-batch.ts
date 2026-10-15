import type { BatchOut, BatchResult } from "@cubby/schemas/batch";

/**
 * Run a batched operation's items with bounded concurrency and positional,
 * independent results (`@cubby/schemas/batch`): an item's error becomes its
 * own `{ ok: false }` result with the raw message, never a whole-batch failure.
 * Keep `concurrency` below the request-local five-client pool so an item's own
 * nested reads still find a connection.
 */
export async function settleBatch<TInput, TOutput>(
  items: readonly TInput[],
  run: (item: TInput, index: number) => Promise<TOutput>,
  {
    concurrency = 3,
    onSettled,
  }: {
    concurrency?: number;
    /** Called as each item settles, for streaming results in finish order. */
    onSettled?: (index: number, result: BatchResult<TOutput>) => void;
  } = {},
): Promise<BatchOut<TOutput>> {
  const results: BatchOut<TOutput>["results"] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      try {
        results[index] = { ok: true, value: await run(items[index]!, index) };
      } catch (error) {
        results[index] = {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      onSettled?.(index, results[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return { results };
}
