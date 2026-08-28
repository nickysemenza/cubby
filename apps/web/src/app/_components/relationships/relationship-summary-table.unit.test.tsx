import type {
  RelatedSummaryInput,
  RelatedSummaryOutput,
} from "@cubby/schemas/related-view";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { flexRender } from "@tanstack/react-table";
import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CubbyTable } from "../data-table/table-features";

const mocks = vi.hoisted(() => {
  const summaryQuery = vi.fn();
  return {
    queryOptions: vi.fn((input: RelatedSummaryInput) => {
      const { offset, ...scope } = input;
      return {
        queryKey: ["related-summary", scope],
        initialPageParam: offset ?? 0,
        queryFn: ({ pageParam }: { pageParam: number }) =>
          summaryQuery({ ...input, offset: pageParam }),
        getNextPageParam: (result: RelatedSummaryOutput) =>
          result.nextOffset ?? undefined,
      };
    }),
    summaryQuery,
    lastTable: { current: null as CubbyTable<Record<string, unknown>> | null },
  };
});

const page = (relationKey: string) => ({
  data: [
    {
      target:
        relationKey === "product.vendors"
          ? null
          : {
              entity: relationKey === "project.vendors" ? "vendor" : "product",
              id: "PRD-TEST",
              label: "Brush",
              image: { url: "https://example.com/brush.jpg" },
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
});

vi.mock("~/lib/related-data.functions", () => ({
  relatedData: { summary: { infiniteQueryOptions: mocks.queryOptions } },
}));
vi.mock("../data-table/Table", () => ({
  default: ({
    table,
    additionalToolbarContent,
  }: {
    table: CubbyTable<Record<string, unknown>>;
    additionalToolbarContent: ReactNode;
  }) => {
    mocks.lastTable.current = table;
    return (
      <div>
        {additionalToolbarContent}
        {table.getRowModel().rows.map((row) => (
          <div key={row.id}>
            {row.getVisibleCells().map((cell) => (
              <span key={cell.id}>
                {flexRender(cell.column.columnDef.cell, cell.getContext())}
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  },
}));
vi.mock("~/app/_components/EntityInlineLink", () => ({
  EntityInlineLink: ({
    data,
    showIdentityMark,
  }: {
    data: { name: string };
    showIdentityMark?: boolean;
  }) => (
    <span
      data-testid="summary-target-link"
      data-show-mark={showIdentityMark === false ? "false" : "true"}
    >
      {data.name}
    </span>
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

const clients: QueryClient[] = [];
const renderTable = (ui: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
};

afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
  mocks.lastTable.current = null;
  mocks.queryOptions.mockClear();
  mocks.summaryQuery.mockReset();
});

describe("RelationshipSummaryTable", () => {
  it("requests the configured server sort and renders incomplete acquisition quantities", async () => {
    mocks.summaryQuery.mockImplementation(async () => page("vendor.products"));
    renderTable(
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
    expect(mocks.queryOptions).toHaveBeenLastCalledWith(
      expect.objectContaining({
        relationKey: "vendor.products",
        sourceId: "VEN-TEST",
        sort: { field: "latestActivity", direction: "desc" },
      }),
      expect.objectContaining({
        initialPageParam: 0,
        page: expect.any(Function),
        getNextPageParam: expect.any(Function),
      }),
    );
    expect(screen.getByTestId("summary-thumbnail")).toHaveAttribute(
      "data-entity",
      "product",
    );
    expect(screen.getByTestId("summary-thumbnail")).toHaveAttribute(
      "data-src",
      "https://example.com/brush.jpg",
    );
    expect(screen.getByTestId("summary-target-link")).toHaveAttribute(
      "data-show-mark",
      "false",
    );
    expect(screen.getByText("+1?")).toBeInTheDocument();
    expect(mocks.summaryQuery).toHaveBeenLastCalledWith(
      expect.objectContaining({
        relationKey: "vendor.products",
        sourceId: "VEN-TEST",
        offset: 0,
        limit: 25,
        sort: { field: "latestActivity", direction: "desc" },
      }),
    );

    // Sorting is manual: the click must re-ask the server, not reorder rows.
    act(() => {
      mocks.lastTable.current?.getColumn("netSpend")?.toggleSorting(true);
    });
    await waitFor(() =>
      expect(mocks.summaryQuery).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sort: { field: "netSpend", direction: "desc" },
        }),
      ),
    );

    expect(screen.getByText(/\$18\.50 net/)).toBeInTheDocument();
  });

  it("only lets the server-sortable columns sort", async () => {
    mocks.summaryQuery.mockImplementation(async () => page("vendor.products"));
    renderTable(
      <RelationshipSummaryTable
        relationKey="vendor.products"
        sourceId="VEN-TEST"
        columns={["target", "unpriced", "netSpend"]}
        defaultSort={{ field: "netSpend", direction: "desc" }}
        emptyCopy="Nothing yet."
        expenseHref={() => "/expenses"}
      />,
    );

    await waitFor(() => expect(mocks.lastTable.current).not.toBeNull());
    expect(mocks.lastTable.current?.getColumn("unpriced")?.getCanSort()).toBe(
      false,
    );
    expect(mocks.lastTable.current?.getColumn("netSpend")?.getCanSort()).toBe(
      true,
    );
  });

  it("uses the vendor mark for vendor-target summaries", async () => {
    mocks.summaryQuery.mockImplementation(async () => page("project.vendors"));
    renderTable(
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
    mocks.summaryQuery.mockImplementation(async () => page("product.vendors"));
    renderTable(
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
      "text-warning-ink",
    );
    expect(
      screen.getByRole("link", { name: /view no purchase\/vendor expenses/i }),
    ).toHaveAttribute("href", "/expenses?productId=PRD-TEST&vendor=__none__");
  });
});
