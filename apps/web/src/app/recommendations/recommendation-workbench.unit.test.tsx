import { testShortcode } from "@cubby/schemas/testing";

import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  mutationOptions: (options: unknown) => options,
  queryOptions: (options: unknown) => options,
  useQuery: () => ({
    data: {
      status: "ready",
      currentTags: ["existing"],
      proposals: [{ tag: "workshop", supportingProductCount: 3 }],
    },
    isLoading: false,
    isError: false,
  }),
  useMutation: vi
    .fn()
    .mockReturnValueOnce({ isPending: false, mutate: mocks.accept })
    .mockReturnValueOnce({ isPending: false, mutate: mocks.dismiss }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));

vi.mock("~/app/problems/components/tier2-fixes", () => ({
  DuplicateProductMergeFix: () => null,
}));

import { RecommendationWorkbench } from "./recommendation-workbench";

describe("RecommendationWorkbench tag propagation", () => {
  it("does not mutate tags until the proposal is explicitly accepted", () => {
    const sourceId = testShortcode("product", "PRD-TAGS");
    render(
      <RecommendationWorkbench sourceId={sourceId} kind="tag-propagation" />,
    );

    expect(mocks.accept).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Accept" }));

    expect(mocks.accept).toHaveBeenCalledWith({
      id: sourceId,
      data: { tags: ["existing", "workshop"] },
    });
  });
});
