import type { Database } from "~/server/db";
import { drainDerivedRefreshFrontier } from "~/server/testing/background-queue";

/** Offline consumers use the same paged frontier as the production queue. */
export async function withDerivedRefresh<T>(
  db: Database,
  run: () => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const pump = (async () => {
    while (!controller.signal.aborted) {
      await drainDerivedRefreshFrontier(db);
      if (!controller.signal.aborted)
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, 100);
        });
    }
  })();
  // Observe failures immediately; teardown still propagates them.
  void pump.catch(() => {});
  const outcome = await run().then(
    (value) => ({ kind: "success" as const, value }),
    (error: unknown) => ({ kind: "failure" as const, error }),
  );
  controller.abort();
  clearTimeout(timer);
  wake?.();
  const errors: unknown[] = outcome.kind === "failure" ? [outcome.error] : [];
  try {
    await pump;
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Journey or derived refresh failed", {
      cause: errors[0],
    });
  if (outcome.kind === "failure") throw outcome.error;
  return outcome.value;
}
