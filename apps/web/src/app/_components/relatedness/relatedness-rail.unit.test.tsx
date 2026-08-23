import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data:
      options.queryKey[0] === "relatedness"
        ? { status: "stale", items: [] }
        : { status: "succeeded" },
  }),
  useMutation: () => ({
    data: { batchId: "00000000-0000-4000-8000-000000000001" },
    isPending: false,
    mutate: mocks.refresh,
  }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    relatedness: {
      product: {
        queryOptions: (id: string) => ({ queryKey: ["relatedness", id] }),
        queryKey: (id: string) => ["relatedness", id],
      },
    },
    search: { requestEmbeddingRefresh: { mutationOptions: () => ({}) } },
    backgroundJobs: {
      getBatchSummary: {
        queryOptions: (input: { batchId: string }) => ({
          queryKey: ["batch", input.batchId],
        }),
      },
    },
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

import { RelatednessRail } from "./relatedness-rail";

describe("RelatednessRail", () => {
  it("refetches relatedness when its Index now batch reaches a terminal state", async () => {
    const productId = unsafeProductShortcode("PRD-INDEX");
    render(<RelatednessRail product={{ id: productId, tags: [] }} />);

    await waitFor(() => {
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: [["relatedness", productId]],
      });
    });
  });
});
