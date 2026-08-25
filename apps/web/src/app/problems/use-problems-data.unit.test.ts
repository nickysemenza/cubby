import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  queryOptions: <T>(options: T) => options,
  useQueries: (input: {
    queries: unknown[];
    combine: (rows: unknown[]) => unknown;
  }) => {
    mocks.useQueries(input);
    return input.combine(Array.from({ length: 5 }, () => ({})));
  },
}));

import { PROBLEMS_QUERY_STALE_TIME } from "./problem-query-freshness";
import { useProblemsData } from "./use-problems-data";

describe("useProblemsData", () => {
  it("keeps every full Problems lane warm for five minutes by default", () => {
    useProblemsData();

    const input = mocks.useQueries.mock.calls[0]?.[0] as {
      queries: Array<{ staleTime?: number }>;
    };
    expect(input.queries).toHaveLength(5);
    expect(input.queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staleTime: PROBLEMS_QUERY_STALE_TIME }),
      ]),
    );
    expect(
      input.queries.every(
        (query) => query.staleTime === PROBLEMS_QUERY_STALE_TIME,
      ),
    ).toBe(true);
  });
});
