import {
  FIELD_SUGGESTIONS_BATCH_MAX,
  type FieldSuggestionsOut,
} from "@cubby/schemas/ai";

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
  return createRequestBatcher<FieldSuggestionSource, FieldSuggestionsOut>(
    async (items, signal) => {
      const batch = current().operations.suggestFieldsBatch;
      if (!batch) throw new Error("Suggestion batch transport unavailable");
      return batch.call(
        {
          items: items.map((item) => ({ ...item, targets: [...item.targets] })),
        },
        { signal, batch: false },
      );
    },
    {
      max: FIELD_SUGGESTIONS_BATCH_MAX,
      concurrency: 1,
      admit: (work, signal) => current().scheduler.run(work, signal),
    },
  );
}
