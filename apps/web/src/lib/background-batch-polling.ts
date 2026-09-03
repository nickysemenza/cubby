import {
  mutationSideEffectsSchema,
  type BackgroundBatchStatus,
  type MutationSideEffects,
} from "@cubby/schemas/background-jobs";
import type { QueryClient } from "@tanstack/react-query";
import { uniq } from "es-toolkit";
import { z } from "zod";

import type { InvalidationTagSet } from "~/integrations/tanstack-query/cache-tags";
import { invalidateOperationTags } from "~/integrations/tanstack-query/operation-cache";
import { backgroundBatch } from "~/lib/background-batch.functions";

/**
 * The standard `fetchBatchStatus` poller passed to
 * {@link watchBatchesAndInvalidateTags}:
 * a fresh summary query (staleTime 0) reduced to its status. It deliberately
 * never loads the batch's jobs: large mutation batches can contain thousands
 * of rows, while this watcher needs one status field.
 */
export interface BackgroundBatchPollingOperations {
  summary: typeof backgroundBatch.summary;
}

const productionBackgroundBatchPollingOperations: BackgroundBatchPollingOperations =
  { summary: backgroundBatch.summary };
const jsonValueSchema = z.json();

export function makeBatchStatusFetcher(
  queryClient: QueryClient,
  operations: BackgroundBatchPollingOperations = productionBackgroundBatchPollingOperations,
) {
  return (batchId: string): Promise<BackgroundBatchStatus> =>
    queryClient
      .fetchQuery({
        ...operations.summary.queryOptions({ batchId }),
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
function extractSideEffects<Result>(
  result: Result,
): MutationSideEffects | undefined {
  const parsedResult = jsonValueSchema.safeParse(result);
  if (!parsedResult.success) return undefined;
  let current: z.output<typeof jsonValueSchema> = parsedResult.data;
  const carrierSchema = z.object({
    sideEffects: mutationSideEffectsSchema.optional(),
    result: z.json().optional(),
  });
  for (;;) {
    const carrier = carrierSchema.safeParse(current);
    if (!carrier.success) return undefined;
    if (carrier.data.sideEffects) return carrier.data.sideEffects;
    if (carrier.data.result === undefined) return undefined;
    // The entity command port answers `{ id, result }`; continue through that
    // parsed JSON envelope until the owned side-effects schema is found.
    current = carrier.data.result;
  }
}

/**
 * Mutations enqueue background work (recipe totals, location valuation, location
 * AI) whose results land *after* the mutation resolves. The mutation's immediate
 * invalidation therefore refetches pre-recompute data and never sees
 * the fresh values. This polls the returned batches and invalidates again once
 * they drain, so the UI self-heals without a manual refresh.
 *
 * No-op when there are no still-running batches — e.g. dev inline processing,
 * which returns already-terminal batches.
 */
async function watchBatches({
  result,
  fetchBatchStatus,
  afterSettled,
}: {
  /** The mutation result; side-effects are extracted from it if present. */
  result: unknown;
  fetchBatchStatus: (batchId: string) => Promise<BackgroundBatchStatus>;
  afterSettled: () => void | Promise<void>;
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

  await afterSettled();
}

export async function watchBatchesAndInvalidateTags({
  queryClient,
  result,
  invalidateTags,
  fetchBatchStatus,
}: {
  queryClient: QueryClient;
  result: unknown;
  invalidateTags: InvalidationTagSet;
  fetchBatchStatus: (batchId: string) => Promise<BackgroundBatchStatus>;
}): Promise<void> {
  await watchBatches({
    result,
    fetchBatchStatus,
    afterSettled: () => invalidateOperationTags(queryClient, invalidateTags),
  });
}
