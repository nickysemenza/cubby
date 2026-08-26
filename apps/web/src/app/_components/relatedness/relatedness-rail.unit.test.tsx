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
      options.queryKey[0] === "operation" &&
      options.queryKey[1] === "relatedness.product"
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

vi.mock("~/lib/recommendations.functions", () => ({
  relatedness: {
    product: {
      queryOptions: (input: string) => ({
        queryKey: ["operation", "relatedness.product", { input }],
      }),
    },
  },
}));

vi.mock("~/lib/search.functions", () => ({
  search: { requestEmbeddingRefresh: { mutationOptions: () => ({}) } },
}));

vi.mock("~/lib/background-batch.functions", () => ({
  backgroundBatch: {
    summary: {
      queryOptions: (input: { batchId: string }) => ({
        queryKey: ["operation", "background-batch.summary", { input }],
      }),
    },
  },
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

vi.mock("~/app/_components/EntityInlineLink", () => ({
  EntityInlineLink: ({
    data,
    displayImage,
  }: {
    data: { name: string };
    displayImage: { url: string } | null;
  }) => (
    <span data-testid="entity-inline-link">
      {data.name}:{displayImage?.url ?? "product-icon"}
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
        queryKey: [["operation", "relatedness.product"]],
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
    expect(screen.getAllByTestId("entity-inline-link")).toHaveLength(2);
    expect(
      screen.getByText(
        "Pictured related product:https://images.example/cover.jpg",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Unpictured related product:product-icon"),
    ).toBeInTheDocument();
  });
});
