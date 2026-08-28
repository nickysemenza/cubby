import { testShortcode } from "@cubby/schemas/testing";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ move: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  mutationOptions: (options: unknown) => options,
  queryOptions: (options: unknown) => options,
  useQuery: () => ({
    data: {
      inventoryId: "INV-PARKED",
      productName: "Widget",
      sourceLocation: { id: "LOC-UNKNOWN", name: "Unknown" },
      destination: { id: "LOC-SHELF", name: "Shelf" },
    },
    isLoading: false,
    isError: false,
  }),
  useMutation: () => ({ isPending: false, mutate: mocks.move }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("~/app/problems/components/tier2-fixes", () => ({
  DuplicateProductMergeFix: () => null,
}));

import { RecommendationWorkbench } from "./recommendation-workbench";

describe("RecommendationWorkbench placement", () => {
  it("does not move inventory until the recommendation is explicitly accepted", () => {
    render(
      <RecommendationWorkbench
        inventoryId={testShortcode("inventory", "INV-PARKED")}
        kind="placement"
      />,
    );

    expect(mocks.move).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Move to Shelf" }));
    expect(mocks.move).toHaveBeenCalledWith({
      items: [
        {
          inventoryEntryId: "INV-PARKED",
          targetLocationId: "LOC-SHELF",
        },
      ],
    });
  });
});
