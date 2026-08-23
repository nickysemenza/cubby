import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidateQueries: vi.fn(),
  refresh: vi.fn(),
  relatedness: { status: "stale", items: [] as Array<unknown> },
  images: {} as Record<string, Array<{ url: string }>>,
  imageSummaryProductIds: [] as string[],
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly unknown[] }) => ({
    data:
      options.queryKey[0] === "relatedness"
        ? mocks.relatedness
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

vi.mock("../products/product-image-summaries", () => ({
  ProductImageSummariesProvider: ({
    productIds,
    children,
  }: {
    productIds: string[];
    children: ReactNode;
  }) => {
    mocks.imageSummaryProductIds = productIds;
    return children;
  },
  useHydratedProductImages: (productId: string) =>
    mocks.images[productId] ?? [],
}));

vi.mock("~/components/entity/entity-identity-mark", () => ({
  EntityIdentityMark: ({
    displayImage,
  }: {
    displayImage: { url: string } | null;
  }) => (
    <span data-testid="identity-mark">
      {displayImage ? `image:${displayImage.url}` : "product-icon"}
    </span>
  ),
}));

import { RelatednessRail } from "./relatedness-rail";

describe("RelatednessRail", () => {
  beforeEach(() => {
    mocks.invalidateQueries.mockClear();
    mocks.relatedness = { status: "stale", items: [] };
    mocks.images = {};
    mocks.imageSummaryProductIds = [];
  });

  it("refetches relatedness when its Index now batch reaches a terminal state", async () => {
    const productId = unsafeProductShortcode("PRD-INDEX");
    render(<RelatednessRail product={{ id: productId, tags: [] }} />);

    await waitFor(() => {
      expect(mocks.invalidateQueries).toHaveBeenCalledWith({
        queryKey: [["relatedness", productId]],
      });
    });

    expect(mocks.imageSummaryProductIds).toEqual([]);
  });

  it("renders image and icon identity marks for ready related products", () => {
    const pictured = unsafeProductShortcode("PRD-PICTURED");
    const unpictured = unsafeProductShortcode("PRD-UNPICTURED");
    mocks.relatedness = {
      status: "ready",
      items: [
        {
          entity: "product",
          shortcode: pictured,
          title: "Pictured related product",
          score: 0.92,
          evidence: [{ signal: "Semantic match", detail: null, weight: 1 }],
        },
        {
          entity: "product",
          shortcode: unpictured,
          title: "Unpictured related product",
          score: 0,
          evidence: [{ signal: "Shared tag", detail: null, weight: 0 }],
        },
      ],
    };
    mocks.images = {
      [pictured]: [{ url: "https://images.example/cover.jpg" }],
    };

    render(
      <RelatednessRail
        product={{ id: unsafeProductShortcode("PRD-SOURCE"), tags: [] }}
      />,
    );

    expect(mocks.imageSummaryProductIds).toEqual([pictured, unpictured]);
    expect(screen.getByText("Pictured related product")).toBeInTheDocument();
    expect(screen.getByText("Unpictured related product")).toBeInTheDocument();
    expect(screen.getAllByTestId("identity-mark")).toHaveLength(2);
    expect(
      screen.getByText("image:https://images.example/cover.jpg"),
    ).toBeInTheDocument();
    expect(screen.getByText("product-icon")).toBeInTheDocument();
  });
});
