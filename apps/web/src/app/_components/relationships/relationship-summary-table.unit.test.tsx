import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn((input) => input),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (input: { relationKey: string }) => ({
    data: {
      data: [
        {
          target:
            input.relationKey === "product.vendors"
              ? null
              : {
                  entity:
                    input.relationKey === "project.vendors"
                      ? "vendor"
                      : "product",
                  id: "PRD-TEST",
                  label: "Brush",
                  image: null,
                },
          expenseCount: 2,
          purchaseCount: 1,
          unpricedExpenseCount: 0,
          netSpend: 18.5,
          latestActivity: "2026-01-02",
          knownAcquiredUnits: 3,
          unknownAcquisitionQuantityCount: 1,
        },
      ],
      count: 1,
      totals: {
        expenseCount: 2,
        purchaseCount: 1,
        unpricedExpenseCount: 0,
        netSpend: 18.5,
        knownAcquiredUnits: 3,
        unknownAcquisitionQuantityCount: 1,
      },
      nextOffset: null,
    },
    isPending: false,
    isError: false,
    isFetching: false,
  }),
}));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    relatedData: { summary: { queryOptions: mocks.queryOptions } },
  }),
}));
vi.mock("~/app/_components/EntityInlineLink", () => ({
  EntityInlineLink: ({ data }: { data: { name: string } }) => (
    <span>{data.name}</span>
  ),
}));
vi.mock("~/app/_components/table/ImageThumbnail", () => ({
  ImageThumbnail: ({
    images,
    entity,
  }: {
    images: Array<{ url: string }>;
    entity: string;
  }) => (
    <span
      data-testid="summary-thumbnail"
      data-entity={entity}
      data-src={images[0]?.url}
    />
  ),
}));
vi.mock("~/components/entity/vendor-cell", () => ({
  VendorMark: ({ vendor }: { vendor: string }) => (
    <span data-testid="summary-vendor-mark">{vendor}</span>
  ),
}));

import { RelationshipSummaryTable } from "./relationship-summary-table";

describe("RelationshipSummaryTable", () => {
  it("requests the configured server sort and renders incomplete acquisition quantities", async () => {
    render(
      <RelationshipSummaryTable
        relationKey="vendor.products"
        sourceId="VEN-TEST"
        columns={["target", "acquired", "netSpend"]}
        defaultSort={{ field: "latestActivity", direction: "desc" }}
        emptyCopy="Nothing yet."
        expenseHref={() => "/expenses"}
      />,
    );

    await waitFor(() => expect(screen.getByText("Brush")).toBeInTheDocument());
    expect(screen.getByTestId("summary-thumbnail")).toHaveAttribute(
      "data-entity",
      "product",
    );
    expect(screen.getByText("+1?")).toBeInTheDocument();
    expect(mocks.queryOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        relationKey: "vendor.products",
        sourceId: "VEN-TEST",
        offset: 0,
        limit: 25,
        sort: { field: "latestActivity", direction: "desc" },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Sort by Net spend" }));

    await waitFor(() =>
      expect(mocks.queryOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sort: { field: "netSpend", direction: "desc" },
        }),
      ),
    );

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search relationship summary" }),
      { target: { value: "brush" } },
    );
    await waitFor(() =>
      expect(mocks.queryOptions).toHaveBeenLastCalledWith(
        expect.objectContaining({ search: "brush" }),
      ),
    );
    expect(screen.getByText(/\$18\.50 net/)).toBeInTheDocument();
  });

  it("uses the vendor mark for vendor-target summaries", async () => {
    render(
      <RelationshipSummaryTable
        relationKey="project.vendors"
        sourceId="PRJ-TEST"
        columns={["target", "netSpend"]}
        defaultSort={{ field: "netSpend", direction: "desc" }}
        emptyCopy="Nothing yet."
        expenseHref={() => "/expenses"}
      />,
    );

    expect(await screen.findByTestId("summary-vendor-mark")).toHaveTextContent(
      "Brush",
    );
  });

  it("warning-styles a null target and keeps its exact ledger link", async () => {
    render(
      <RelationshipSummaryTable
        relationKey="product.vendors"
        sourceId="PRD-TEST"
        columns={["target", "expenses", "netSpend"]}
        defaultSort={{ field: "latestActivity", direction: "desc" }}
        emptyCopy="Nothing yet."
        nullLabel="No purchase/vendor"
        expenseHref={() => "/expenses?productId=PRD-TEST&vendor=__none__"}
      />,
    );

    expect(await screen.findByText("No purchase/vendor")).toHaveClass(
      "text-warning",
    );
    expect(
      screen.getByRole("link", { name: /view no purchase\/vendor expenses/i }),
    ).toHaveAttribute("href", "/expenses?productId=PRD-TEST&vendor=__none__");
  });
});
