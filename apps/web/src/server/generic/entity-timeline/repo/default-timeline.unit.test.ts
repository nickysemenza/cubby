import { displayImagesField } from "@cubby/schemas/display-images";
import { computedFieldEnvelope } from "@cubby/schemas/field-envelope";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { fieldValueFixture } from "~/entity/fields/field-envelope.fixtures";

import { lifecycleRows } from "./default-timeline";

/** Minimal ordered-fallback lifecycle: two start candidates, one milestone, one end. */
const lifecycle = {
  start: ["season.start", "transplantedOn"],
  milestones: ["milestoneDate"],
  end: "season.end",
} as const;

const window = { order: "desc" as const };

const record = (
  fields: Record<
    string,
    string | { start: string | null; end: string | null } | null | undefined
  >,
) => ({
  id: "PLT-TEST",
  displayImages: [],
  season: null,
  transplantedOn: null,
  milestoneDate: null,
  ...fields,
});

describe("lifecycleRows", () => {
  it.each([
    {
      name: "first start key set",
      fields: { season: { start: "2026-03-01", end: "2026-06-01" } },
      intervals: [{ start: "2026-03-01", end: "2026-06-01", confident: true }],
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

it("uses governed lifecycle titles and preferred covers without reviving retired values", () => {
  const snapshot = [
    {
      id: "IMG-4K7M",
      url: "https://example.test/original.jpg",
      representations: {
        original: "https://example.test/original.jpg",
        transparent: "https://example.test/cutout.png",
        preferred: "https://example.test/cutout.png",
        preferredKind: "transparent",
      },
    },
  ];
  const schema = computedFieldEnvelope(displayImagesField);
  for (const [value, expected] of [
    [snapshot, "https://example.test/cutout.png"],
    [[], null],
    [undefined, null],
  ]) {
    const input = {
      ...record({ season: { start: "2026-03-01", end: "2026-06-01" } }),
      displayImages: snapshot,
      displayName: "Stale flat title",
      fields: {
        displayImages: fieldValueFixture(schema, value),
        displayName: fieldValueFixture(
          computedFieldEnvelope(z.string()),
          "Synthetic governed title",
        ),
      },
    };
    const [row] = lifecycleRows("planting", [input], lifecycle, window);
    expect(row?.imageUrl).toBe(expected);
    expect(row?.name).toBe("Synthetic governed title");
  }
});
