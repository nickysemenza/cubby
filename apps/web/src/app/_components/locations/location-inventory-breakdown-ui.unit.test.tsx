import { testShortcode } from "@cubby/schemas/testing";

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryOptions: vi.fn(),
  useQuery: vi.fn(),
  drilldown: vi.fn(),
  refetch: vi.fn(),
  query: {
    isPending: false,
    isError: false,
    data: undefined as unknown,
    refetch: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => {
    mocks.useQuery(options);
    return mocks.query;
  },
}));
vi.mock("~/app/locations/location.functions", () => ({
  location: {
    inventoryBreakdown: { queryOptions: mocks.queryOptions },
  },
}));
vi.mock("~/app/_components/visualizations/hierarchy-drilldown", () => ({
  HierarchyDrilldown: (props: unknown) => {
    mocks.drilldown(props);
    return <div data-testid="drilldown" />;
  },
}));

import { LocationInventoryBreakdown } from "./location-inventory-breakdown";

const rootId = testShortcode("location", "LOC-ROOT");

beforeEach(() => {
  mocks.queryOptions.mockReset();
  mocks.useQuery.mockReset();
  mocks.drilldown.mockReset();
  mocks.refetch.mockReset();
  mocks.query = {
    isPending: false,
    isError: false,
    data: undefined,
    refetch: mocks.refetch,
  };
});

describe("LocationInventoryBreakdown", () => {
  it("disables the query and renders nothing for a leaf location", () => {
    const { container } = render(
      <LocationInventoryBreakdown shortcode={rootId} hasChildren={false} />,
    );

    expect(mocks.queryOptions).toHaveBeenCalledWith({ shortcode: rootId });
    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a compact loading state while the descendant tree loads", () => {
    mocks.query.isPending = true;
    render(
      <LocationInventoryBreakdown shortcode={rootId} hasChildren={true} />,
    );

    expect(
      screen.getByLabelText("Loading contents breakdown"),
    ).toBeInTheDocument();
  });

  it("offers a retry when the count tree fails", () => {
    mocks.query.isError = true;
    render(
      <LocationInventoryBreakdown shortcode={rootId} hasChildren={true} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });

  it("renders only when stock exists below the current location", () => {
    const descendantTree = {
      id: rootId,
      name: "Workshop",
      type: "room",
      directItemCount: 1,
      totalItemCount: 3,
      children: [
        {
          id: testShortcode("location", "LOC-CHLD"),
          name: "Shelf",
          type: "shelf",
          directItemCount: 2,
          totalItemCount: 2,
          children: [],
        },
      ],
    };
    mocks.query.data = descendantTree;
    const { rerender } = render(
      <LocationInventoryBreakdown shortcode={rootId} hasChildren={true} />,
    );

    expect(screen.getByTestId("drilldown")).toBeInTheDocument();
    expect(mocks.drilldown).toHaveBeenCalledWith(
      expect.objectContaining({
        ariaLabel: "Contents breakdown",
        root: expect.objectContaining({
          label: "Workshop",
          metricLabel: "3 items",
        }),
      }),
    );

    mocks.query.data = {
      ...descendantTree,
      totalItemCount: 1,
      children: [],
    };
    rerender(
      <LocationInventoryBreakdown shortcode={rootId} hasChildren={true} />,
    );
    expect(screen.queryByTestId("drilldown")).not.toBeInTheDocument();
  });
});
