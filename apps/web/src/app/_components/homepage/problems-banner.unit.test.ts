import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCountsOptions: vi.fn(() => ({ queryKey: ["problems", "counts"] })),
  useQuery: vi.fn(() => ({ data: undefined, isLoading: true })),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("~/hooks/useHydrated", () => ({ useHydrated: () => true }));
vi.mock("~/lib/auth-client", () => ({
  authClient: { useSession: () => ({ data: { user: { id: "test" } } }) },
}));
vi.mock("~/integrations/trpc/react", () => ({
  useTRPC: () => ({
    problems: {
      getCounts: { queryOptions: mocks.getCountsOptions },
    },
  }),
}));

import { ProblemsBanner } from "./problems-banner";

describe("ProblemsBanner", () => {
  beforeEach(() => {
    mocks.getCountsOptions.mockClear();
    mocks.useQuery.mockClear();
  });

  it("shares the count route and five-minute cache with the navbar", () => {
    ProblemsBanner();

    expect(mocks.getCountsOptions).toHaveBeenCalledOnce();
    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ["problems", "counts"],
        staleTime: 5 * 60 * 1000,
        enabled: true,
      }),
    );
  });
});
