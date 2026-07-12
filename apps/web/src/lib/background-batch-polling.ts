import type {
  BackgroundBatchStatus,
  MutationSideEffects,
} from "@cubby/schemas/background-jobs";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import type { useTRPC } from "~/integrations/trpc/react";
import { invalidateTRPCQueries } from "~/lib/query-keys";

type Api = ReturnType<typeof useTRPC>;

/**
 * The standard `fetchBatchStatus` poller passed to {@link watchBatchesAndInvalidate}:
 * a fresh `getBatch` query (staleTime 0) reduced to its status. Shared by every
 * mutation hook so the closure isn't hand-rolled per call site.
 */
export function makeBatchStatusFetcher(queryClient: QueryClient, api: Api) {
  return (batchId: string): Promise<BackgroundBatchStatus> =>
    queryClient
      .fetchQuery({
        ...api.backgroundJobs.getBatch.queryOptions({ batchId }),
        staleTime: 0,
      })
      .then((batch) => batch.status);
}

const TERMINAL_STATUSES: ReadonlySet<BackgroundBatchStatus> = new Set([
  "succeeded",
  "partial",
  "failed",
  "cancelled",
]);

const POLL_INTERVAL_MS = 1_500;
const MAX_ATTEMPTS = 30; // ~45s ceiling before we give up and invalidate anyway

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Pull a mutation result's side-effects, if it carries any (many don't). */
function extractSideEffects(result: unknown): MutationSideEffects | undefined {
  if (result && typeof result === "object" && "sideEffects" in result) {
    return (result as { sideEffects?: MutationSideEffects }).sideEffects;
  }
  return undefined;
}

/**
 * Mutations enqueue background work (recipe totals, location valuation, location
 * AI) whose results land *after* the mutation resolves. The mutation's immediate
 * `invalidateTRPCQueries` therefore refetches pre-recompute data and never sees
 * the fresh values. This polls the returned batches and invalidates again once
 * they drain, so the UI self-heals without a manual refresh.
 *
 * No-op when there are no still-running batches — e.g. dev inline processing,
 * which returns already-terminal batches.
 */
export async function watchBatchesAndInvalidate({
  queryClient,
  result,
  invalidateKeys,
  fetchBatchStatus,
}: {
  queryClient: QueryClient;
  /** The mutation result; side-effects are extracted from it if present. */
  result: unknown;
  invalidateKeys: readonly QueryKey[];
  fetchBatchStatus: (batchId: string) => Promise<BackgroundBatchStatus>;
}): Promise<void> {
  const sideEffects = extractSideEffects(result);
  let pending = uniq(
    (sideEffects?.backgroundBatches ?? [])
      .filter((batch) => !TERMINAL_STATUSES.has(batch.status))
      .map((batch) => batch.id),
  );
  if (pending.length === 0) return;

  for (
    let attempt = 0;
    attempt < MAX_ATTEMPTS && pending.length > 0;
    attempt++
  ) {
    await sleep(POLL_INTERVAL_MS);
    const stillPending: string[] = [];
    await Promise.all(
      pending.map(async (batchId) => {
        try {
          const status = await fetchBatchStatus(batchId);
          if (!TERMINAL_STATUSES.has(status)) stillPending.push(batchId);
        } catch {
          // Best-effort: stop tracking a batch we can't read.
        }
      }),
    );
    pending = stillPending;
  }

  invalidateTRPCQueries(queryClient, invalidateKeys);
}
