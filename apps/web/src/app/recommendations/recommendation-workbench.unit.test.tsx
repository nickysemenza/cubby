import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accept: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
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

vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    recommendations: {
      tagPropagation: {
        queryOptions: () => ({}),
        queryKey: () => ["tag-propagation"],
      },
      dismissTagPropagation: { mutationOptions: () => ({}) },
    },
    product: { update: { mutationOptions: () => ({}) } },
    relatedness: { product: { queryKey: () => ["relatedness"] } },
  }),
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
    const sourceId = unsafeProductShortcode("PRD-TAGS");
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
