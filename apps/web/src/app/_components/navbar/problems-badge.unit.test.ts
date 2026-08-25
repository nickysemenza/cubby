import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(() => ({ data: undefined, isLoading: true })),
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: <T>(options: T) => options,
  useQuery: mocks.useQuery,
}));
vi.mock("~/hooks/useHydrated", () => ({ useHydrated: () => true }));
vi.mock("~/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "test" } } }) },
}));

import { ProblemsBadge } from "./problems-badge";

describe("ProblemsBadge", () => {
  beforeEach(() => {
    mocks.useQuery.mockClear();
  });

  it("requests the count-only route with the five-minute cache", () => {
    ProblemsBadge();

    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [["problems", "getCounts"], { type: "query" }],
        staleTime: 5 * 60 * 1000,
        enabled: true,
      }),
    );
  });
});
