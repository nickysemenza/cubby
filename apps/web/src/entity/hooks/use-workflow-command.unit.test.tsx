import { assessmentReviewBatchInput } from "@cubby/schemas/assessment";
import {
  MutationCache,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import superjson from "superjson";
import { afterEach, expect, it, vi } from "vitest";

import { loadWorkflowCommandOptions } from "~/integrations/tanstack-query/generated/commands.gen";
import { getContext } from "~/integrations/tanstack-query/root-provider";

import { useWorkflowCommand } from "./use-workflow-command";

afterEach(() => vi.unstubAllGlobals());

// Losing catalog metadata bypasses invalidation; losing scope overlaps Run writes.
it("serializes scoped operations while publishing their exact bodies and metadata", async () => {
  // Load the real command before timing scope scheduling, independently of cold imports.
  await loadWorkflowCommandOptions("assessment.reviewBatch");
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
    () => useWorkflowCommand({ scope: { id: "synthetic-run" } }),
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

// Saved results land before refetch without holding the write behind that read.
it("patches before catalog invalidation and finishes while refresh is pending", async () => {
  const gate = Promise.withResolvers<void>();
  const events: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        superjson.serialize({
          ok: true,
          data: [{ assessmentId: null, ok: false, error: "Synthetic refusal" }],
        }),
      ),
    ),
  );
  const { queryClient: client } = getContext();
  const activeKey = ["synthetic-active-review"];
  const inactiveKey = ["synthetic-inactive-review"];
  client.setQueryData(activeKey, "old");
  client.getQueryCache().build(client, {
    queryKey: inactiveKey,
    queryFn: async () => null,
    meta: { cacheTags: [["suggestions"]] },
  });
  const observer = new QueryObserver(client, {
    queryKey: activeKey,
    meta: { cacheTags: [["suggestions"]] },
    queryFn: async () => {
      events.push("refresh");
      await gate.promise;
      return "fresh";
    },
  });
  const unsubscribe = observer.subscribe(() => undefined);
  const { result } = renderHook(
    () =>
      useWorkflowCommand({
        onResult: async () => {
          events.push("patch");
          client.setQueryData(activeKey, "committed");
        },
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  let settled = false;
  const pending: Promise<unknown>[] = [];
  act(() => {
    pending.push(
      result.current
        .mutateAsync({
          kind: "operation",
          operation: "assessment.reviewBatch",
          body: {
            items: [{ operationId: "synthetic-refresh", verdict: "dismissed" }],
          },
        })
        .then(() => {
          settled = true;
        }),
    );
  });
  try {
    await waitFor(() => expect(events).toContain("refresh"));
    expect(events.slice(0, 2)).toEqual(["patch", "refresh"]);
    expect(client.getQueryData(activeKey)).toBe("committed");
    await waitFor(() => expect(settled).toBe(true));
    await act(async () => {
      gate.resolve();
      await Promise.all(pending);
    });
    expect(
      client.getQueryCache().find({ queryKey: inactiveKey }),
    ).toBeUndefined();
    expect(client.getQueryData(activeKey)).toBe("fresh");
  } finally {
    await act(async () => {
      gate.resolve();
      await Promise.all(pending);
    });
    unsubscribe();
    client.clear();
  }
});
