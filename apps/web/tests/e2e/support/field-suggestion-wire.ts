import {
  fieldSuggestionsBatchInput,
  fieldSuggestionsOut,
} from "@cubby/schemas/ai";
import type { Request } from "@playwright/test";
import type { z } from "zod";

import { dispatchOperations } from "./dispatch-wire";

/** The same synthetic model answer for an editor ask or each list-batch item. */
export function fieldSuggestionsReply(
  request: Request,
  value: z.input<typeof fieldSuggestionsOut>,
) {
  const output = fieldSuggestionsOut.parse(value);
  const [operation] = dispatchOperations(request);
  return operation?.operation === "ai.suggestFieldsBatch"
    ? {
        results: fieldSuggestionsBatchInput
          .parse(operation.input)
          .items.map(() => ({ ok: true as const, value: output })),
      }
    : output;
}
