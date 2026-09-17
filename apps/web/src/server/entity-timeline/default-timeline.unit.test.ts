import { describe, expect, it } from "vitest";

import { lifecycleRows } from "./default-timeline";

/** Minimal ordered-fallback lifecycle: two start candidates, one milestone, one end. */
const lifecycle = {
  start: ["sowedOn", "transplantedOn"],
  milestones: ["milestoneDate"],
  end: "finishedOn",
} as const;

const window = { order: "desc" as const };

const record = (fields: Record<string, string | null | undefined>) => ({
  id: "PLT-TEST",
  displayImages: [],
  sowedOn: null,
  transplantedOn: null,
  milestoneDate: null,
  finishedOn: null,
  ...fields,
});

describe("lifecycleRows", () => {
  it.each([
    {
      name: "first start key set",
      fields: { sowedOn: "2026-03-01" },
      intervals: [{ start: "2026-03-01", end: null, confident: true }],
    },
    {
      name: "first start key null, second set: interval starts at the fallback, unconfident",
      fields: { transplantedOn: "2026-04-13" },
      intervals: [{ start: "2026-04-13", end: null, confident: false }],
    },
  ])("$name", ({ fields, intervals }) => {
    const [row] = lifecycleRows(
      "planting",
      [record(fields)],
      lifecycle,
      window,
    );
    expect(row?.intervals).toEqual(intervals);
    expect(row?.link).toEqual({ entity: "planting", id: "PLT-TEST" });
  });

  it("emits no interval when every start key is null, but still emits markers for other dated fields", () => {
    const [row] = lifecycleRows(
      "planting",
      [record({ milestoneDate: "2026-05-01" })],
      lifecycle,
      window,
    );
    expect(row?.intervals).toEqual([]);
    expect(row?.markers).toEqual([
      {
        date: "2026-05-01",
        kind: "field:milestoneDate",
        link: { entity: "planting", id: "PLT-TEST" },
      },
    ]);
  });

  it("drops the row entirely when neither an interval start nor any marker is present", () => {
    const rows = lifecycleRows("planting", [record({})], lifecycle, window);
    expect(rows).toEqual([]);
  });
});
