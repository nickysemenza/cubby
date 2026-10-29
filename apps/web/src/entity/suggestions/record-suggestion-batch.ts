import {
  FIELD_SUGGESTIONS_BATCH_MAX,
  type FieldSuggestionsOut,
} from "@cubby/schemas/ai";

import type { OperationCallOptions } from "~/integrations/tanstack-query/operation-call";
import { createRequestBatcher } from "~/integrations/tanstack-query/request-batcher";
import type { createConcurrencyLimiter } from "~/lib/concurrency-limiter";

import type {
  EntitySuggestionsOperations,
  FieldSuggestionSource,
} from "./field-suggestion";

/** Loaded when the first active list query asks, keeping SSR's initial graph small. */
export function createRecordSuggestionBatch(
  current: () => {
    operations: EntitySuggestionsOperations;
    scheduler: ReturnType<typeof createConcurrencyLimiter>;
  },
) {
  const batcher = createRequestBatcher<
    {
      source: FieldSuggestionSource;
      consistency?: OperationCallOptions["consistency"];
    },
    FieldSuggestionsOut
  >(
    async (items, signal) => {
      const batch = current().operations.suggestFieldsBatch;
      if (!batch) throw new Error("Suggestion batch transport unavailable");
      return batch.call(
        {
          items: items.map(({ source }) => ({
            ...source,
            targets: [...source.targets],
          })),
        },
        {
          signal,
          batch: false,
          consistency: items.some((item) => item.consistency === "strong")
            ? "strong"
            : undefined,
        },
      );
    },
    {
      max: FIELD_SUGGESTIONS_BATCH_MAX,
      concurrency: 1,
      admit: (work, signal) => current().scheduler.run(work, signal),
    },
  );
  return {
    load(
      source: FieldSuggestionSource,
      signal: AbortSignal,
      consistency?: OperationCallOptions["consistency"],
    ) {
      return batcher.load({ source, consistency }, signal);
    },
  };
}
