import { assessmentReviewBatchInput } from "@cubby/schemas/assessment";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import superjson from "superjson";
import { afterEach, expect, it, vi } from "vitest";

import { useWorkflowCommand } from "./use-workflow-command";

afterEach(() => vi.unstubAllGlobals());

// Losing catalog metadata bypasses invalidation; losing scope overlaps Run writes.
it("serializes scoped operations while publishing their exact bodies and metadata", async () => {
  const gate = Promise.withResolvers<void>();
  const fetchResponse = vi.fn(async () => {
    await gate.promise;
    return Response.json(
      superjson.serialize({
        ok: true,
        data: [{ assessmentId: null, ok: false, error: "Synthetic refusal" }],
      }),
    );
  });
  vi.stubGlobal("fetch", fetchResponse);
  const observed = vi.fn();
  const client = new QueryClient({
    mutationCache: new MutationCache({
      onSuccess: (_data, variables, _context, mutation) => {
        if (mutation.options.meta?.operation === "assessment.reviewBatch")
          observed(variables);
      },
    }),
  });
  const { result } = renderHook(
    () => useWorkflowCommand({ id: "synthetic-run" }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const body = assessmentReviewBatchInput.parse({
    items: [{ operationId: "synthetic-receipt", verdict: "dismissed" }],
  });
  const pending: Promise<unknown>[] = [];
  act(() => {
    pending.push(
      result.current.mutateAsync({
        kind: "operation",
        operation: "assessment.reviewBatch",
        body,
      }),
    );
    pending.push(
      result.current.mutateAsync({
        kind: "operation",
        operation: "assessment.reviewBatch",
        body,
      }),
    );
  });
  await waitFor(() =>
    expect(
      client
        .getMutationCache()
        .getAll()
        .filter(
          (mutation) =>
            mutation.options.meta?.operation === "assessment.reviewBatch",
        ),
    ).toHaveLength(2),
  );
  expect(fetchResponse).toHaveBeenCalledTimes(1);
  await act(async () => {
    gate.resolve();
    await Promise.all(pending);
  });
  expect(fetchResponse).toHaveBeenCalledTimes(2);
  expect(observed.mock.calls).toEqual([[body], [body]]);
  client.clear();
});
