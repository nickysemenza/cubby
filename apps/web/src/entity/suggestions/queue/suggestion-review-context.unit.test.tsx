import {
  assessmentReviewInput,
  type AssessmentReviewBatchOut,
} from "@cubby/schemas/assessment";
import type { SuggestionListRow } from "@cubby/schemas/suggestion-list";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { fromPartial } from "@total-typescript/shoehorn";
import type { ReactNode } from "react";
import superjson from "superjson";
import { afterEach, expect, it, vi } from "vitest";

import type { ReviewItem } from "./suggestion-review";
import {
  SuggestionReviewProvider,
  useSuggestionReview,
} from "./suggestion-review-context";

afterEach(() => vi.unstubAllGlobals());

// A completed request belongs to the submitted view, even if the same row appears elsewhere.
it("does not publish an old review failure into a new scope", async () => {
  const gate = Promise.withResolvers<AssessmentReviewBatchOut>();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        superjson.serialize({ ok: true, data: await gate.promise }),
      ),
    ),
  );
  const client = new QueryClient();
  const id = crypto.randomUUID();
  const row = fromPartial<SuggestionListRow>({ id });
  const item: ReviewItem = {
    ...assessmentReviewInput.parse({
      operationId: "synthetic-review",
      verdict: "dismissed",
      intent: "history",
    }),
    application: undefined,
  };
  let scope = "first";
  const { result, rerender } = renderHook(() => useSuggestionReview(), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <SuggestionReviewProvider scope={scope}>
          {children}
        </SuggestionReviewProvider>
      </QueryClientProvider>
    ),
  });
  const pending: Promise<unknown>[] = [];
  act(() => {
    pending.push(result.current.review([row], () => item));
  });
  await waitFor(() =>
    expect(result.current.outcome(id)?.state).toBe("pending"),
  );
  scope = "second";
  rerender();
  expect(result.current.outcome(id)).toBeUndefined();
  scope = "first";
  rerender();
  await act(async () => {
    gate.resolve([
      { assessmentId: null, ok: false, error: "Synthetic old-scope failure" },
    ]);
    await Promise.all(pending);
  });
  expect(result.current.outcome(id)).toBeUndefined();
  expect(result.current.failures).toEqual([]);
  client.clear();
});
