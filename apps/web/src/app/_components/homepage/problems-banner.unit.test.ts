import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(() => ({ data: undefined, isLoading: true })),
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: <T>(options: T) => options,
  useQuery: mocks.useQuery,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: () => null,
  useRouteContext: () => ({ isAuthed: true }),
}));

import { ProblemsBanner } from "./problems-banner";

describe("ProblemsBanner", () => {
  beforeEach(() => {
    mocks.useQuery.mockClear();
  });

  it("shares the count route and five-minute cache with the navbar", () => {
    ProblemsBanner();

    expect(mocks.useQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [["problems", "getCounts"], { type: "query" }],
        staleTime: 5 * 60 * 1000,
        enabled: true,
      }),
    );
  });
});
