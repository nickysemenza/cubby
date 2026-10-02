import { describe, expect, it } from "vitest";

import { type CrossTabColumn, groupColumnRuns } from "./group-columns";

const col = (key: string, groupKey?: string): CrossTabColumn<string> => ({
  key,
  data: key,
  groupKey,
});

describe("groupColumnRuns", () => {
  it("collapses consecutive columns sharing a group key", () => {
    const runs = groupColumnRuns([
      col("a", "meal-1"),
      col("b", "meal-1"),
      col("c", "meal-2"),
    ]);

    expect(runs).toHaveLength(2);
    expect(runs[0]?.groupKey).toBe("meal-1");
    expect(runs[0]?.columns.map((c) => c.key)).toEqual(["a", "b"]);
    expect(runs[1]?.columns.map((c) => c.key)).toEqual(["c"]);
  });

  it("keeps non-consecutive runs of the same key separate", () => {
    // Gathering them would mean reordering the caller's columns, and column
    // order is the caller's decision (the shopping matrix orders by date).
    const runs = groupColumnRuns([
      col("a", "meal-1"),
      col("b", "meal-2"),
      col("c", "meal-1"),
    ]);

    expect(runs.map((r) => r.groupKey)).toEqual(["meal-1", "meal-2", "meal-1"]);
    expect(runs.every((r) => r.columns.length === 1)).toBe(true);
  });

  it("never merges ungrouped columns with each other", () => {
    const runs = groupColumnRuns([col("a"), col("b")]);

    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.groupKey === undefined)).toBe(true);
  });

  it("spans exactly the columns rendered beneath them", () => {
    const columns = [col("a", "g1"), col("b", "g1"), col("c"), col("d", "g2")];

    const runs = groupColumnRuns(columns);

    // A colSpan built from these runs has to tile the column list exactly, or
    // the header row and the body row drift apart by a cell.
    expect(runs.reduce((n, r) => n + r.columns.length, 0)).toBe(columns.length);
  });

  it("returns nothing for no columns", () => {
    expect(groupColumnRuns([])).toEqual([]);
  });
});
