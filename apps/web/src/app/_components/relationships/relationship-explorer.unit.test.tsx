import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refetch: vi.fn(),
  preview: vi.fn(),
}));

vi.mock("~/hooks/useHydrated", () => ({
  useHydratedLoading: (isLoading: boolean) => isLoading,
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ fetchQuery: vi.fn() }),
}));

vi.mock("./relationship-route-preview", () => ({
  useRelationshipRoutePreview: (...args: unknown[]) => mocks.preview(...args),
}));

vi.mock("./relationship-tree", () => ({
  RelationshipTree: () => <div data-testid="relationship-tree" />,
}));

import { RelationshipExplorer } from "./relationship-explorer";

const views = [{ key: "vendor.purchases", label: "Purchases" }];
const defaultResult = {
  groups: [
    {
      relationKey: "vendor.purchases",
      totalCount: 1,
      items: [],
    },
  ],
  relationKeys: ["vendor.purchases"],
  views,
  query: {
    isError: false,
    isLoading: false,
    refetch: mocks.refetch,
  },
};

describe("RelationshipExplorer", () => {
  beforeEach(() => {
    mocks.refetch.mockReset();
    mocks.preview.mockReset();
    mocks.preview.mockReturnValue(defaultResult);
  });

  it("states when a registered relationship has no linked records", () => {
    mocks.preview.mockReturnValue({
      ...defaultResult,
      groups: [
        {
          relationKey: "vendor.purchases",
          totalCount: 0,
          items: [],
        },
      ],
    });

    render(<RelationshipExplorer entity="vendor" sourceId="VEN-4K7M" />);

    expect(screen.getByText("No linked records.")).toBeVisible();
    expect(screen.queryByTestId("relationship-tree")).toBeNull();
  });

  it("offers a top-level retry when relationship previews fail", () => {
    mocks.preview.mockReturnValue({
      ...defaultResult,
      query: {
        ...defaultResult.query,
        isError: true,
      },
    });
    render(<RelationshipExplorer entity="vendor" sourceId="VEN-4K7M" />);

    expect(
      screen.getByText("Relationships could not be loaded."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});
