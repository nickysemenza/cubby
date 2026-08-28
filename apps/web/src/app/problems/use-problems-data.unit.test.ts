import { describe, expect, it } from "vitest";

import { PROBLEMS_QUERY_STALE_TIME } from "./problem-query-freshness";
import { createProblemGroupQueries } from "./use-problems-data";

describe("useProblemsData", () => {
  it("keeps every full Problems lane warm for five minutes by default", () => {
    const queries = Object.values(createProblemGroupQueries());

    expect(queries).toHaveLength(5);
    expect(queries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staleTime: PROBLEMS_QUERY_STALE_TIME }),
      ]),
    );
    expect(
      queries.every((query) => query.staleTime === PROBLEMS_QUERY_STALE_TIME),
    ).toBe(true);
  });
});
