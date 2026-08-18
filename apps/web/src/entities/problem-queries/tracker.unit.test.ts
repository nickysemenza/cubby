import { describe, expect, it } from "vitest";
import { trackerProblemQueries } from "./tracker";

describe("trackerProblemQueries", () => {
  it("keeps the four entity-grain rules continuable and date drift derived", () => {
    const byKey = new Map(
      trackerProblemQueries.map((query) => [query.key, query]),
    );
    for (const key of [
      "overdueTasks",
      "stalledProjects",
      "projectsMissingBudget",
      "blockedWorkProjects",
    ] as const) {
      expect(byKey.get(key)?.source.kind).toBe("entity");
      expect(byKey.get(key)?.continuation).toEqual({ kind: "entity-list" });
    }
    expect(byKey.get("projectsWithDateDrift")?.source.kind).toBe("derived");
    expect(byKey.get("projectsWithDateDrift")?.continuation.kind).toBe("none");
  });
});
