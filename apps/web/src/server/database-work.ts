import { AsyncLocalStorage } from "node:async_hooks";

import type { DatabaseWorkPriority } from "@cubby/schemas/database-work";

import { getDatabaseWorkOwner } from "./cf-env";
import { withTrace } from "./tracing";

const priorities = new AsyncLocalStorage<{
  priority: DatabaseWorkPriority;
  signal?: AbortSignal;
}>();
const noPermit: Disposable = { [Symbol.dispose]() {} };

export const withDatabaseWorkPriority = <T>(
  priority: DatabaseWorkPriority,
  work: () => Promise<T>,
  signal?: AbortSignal,
) =>
  priorities.run(
    { priority, signal: signal ?? priorities.getStore()?.signal },
    work,
  );

export async function acquireDatabaseWork(
  priority: DatabaseWorkPriority = priorities.getStore()?.priority ??
    "interactive",
): Promise<Disposable> {
  const owner = getDatabaseWorkOwner();
  if (!owner) return noPermit;
  const signal = priorities.getStore()?.signal;
  signal?.throwIfAborted();
  return withTrace("db.admission", async (span) => {
    span.setAttribute("cubby.db.priority", priority);
    const startedAt = performance.now();
    const pending = owner.requestDatabaseWork({
      priority,
      waitTimeoutMs: 30_000,
    });
    const admission = Promise.all([pending, pending.ready()]);
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
    try {
      const [ticket, ready] = await Promise.race([admission, aborted]);
      if (!ready.ok) throw new Error(ready.error);
      return ticket;
    } catch (error) {
      void pending
        .then(async (ticket: Awaited<typeof pending>) => {
          try {
            await ticket.release();
          } finally {
            ticket[Symbol.dispose]();
          }
        })
        .catch(() => {
          // SILENT: the original admission error is rethrown; cleanup cannot replace it.
        });
      throw error;
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      span.setAttribute(
        "db.admission.duration_ms",
        Math.round(performance.now() - startedAt),
      );
    }
  });
}
