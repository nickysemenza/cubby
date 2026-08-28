import type { LocationSuggestionAiResult } from "@cubby/schemas/ai";
import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import type { LocationPutAwayCandidate } from "~/server/repo/location";

import {
  formatLocationCandidates,
  resolveSuggestedLocation,
} from "./location-suggest";

const candidate = (
  overrides: Omit<Partial<LocationPutAwayCandidate>, "id"> & { id: string },
): LocationPutAwayCandidate => ({
  name: "Shelf 1",
  type: "shelf",
  ancestors: [],
  itemCount: 0,
  tagSiblings: 0,
  manufacturerSiblings: 0,
  categorySiblings: 0,
  holdsProduct: false,
  ...overrides,
  id: testShortcode("location", overrides.id),
});

const aiResult = (locationId: string): LocationSuggestionAiResult => ({
  locationId,
  confidence: "high",
  reasoning: "It is the PACKOUT wall.",
});

describe("formatLocationCandidates", () => {
  it("renders the ancestor chain so same-named shelves are distinguishable", () => {
    const lines = formatLocationCandidates([
      candidate({
        id: "LOC-1111",
        name: "Shelf 3",
        ancestors: [
          {
            id: testShortcode("location", "LOC-AAAA"),
            name: "Garage",
            type: "room",
          },
          {
            id: testShortcode("location", "LOC-BBBB"),
            name: "Shelving Unit",
            type: "area",
          },
        ],
        itemCount: 12,
      }),
    ]);

    expect(lines).toBe(
      `${testShortcode("location", "LOC-1111")} | Garage > Shelving Unit > Shelf 3 (shelf) - 12 items`,
    );
  });

  it("prints only the hints that carry evidence", () => {
    const lines = formatLocationCandidates([
      candidate({
        id: "LOC-2222",
        name: "PACKOUT Wall",
        itemCount: 9,
        tagSiblings: 3,
        categorySiblings: 7,
        holdsProduct: true,
      }),
      candidate({ id: "LOC-3333", name: "Empty Bin" }),
    ]).split("\n");

    expect(lines[0]).toBe(
      "LOC-2222 | PACKOUT Wall (shelf) - 9 items; already stocked here, 3 share tags, 7 same category",
    );
    // No zero-valued hints, and an unstocked location still gets offered.
    expect(lines[1]).toBe("LOC-3333 | Empty Bin (shelf) - 0 items");
  });

  it("omits the type when a location has none", () => {
    const lines = formatLocationCandidates([
      candidate({ id: "LOC-4444", name: "Red Crate", type: null }),
    ]);

    expect(lines).toBe("LOC-4444 | Red Crate - 0 items");
  });

  it("discloses the omission when the roster exceeds the cap", () => {
    const many = Array.from({ length: 405 }, (_, i) =>
      candidate({ id: `LOC-${String(i).padStart(4, "0")}` }),
    );

    const lines = formatLocationCandidates(many).split("\n");

    expect(lines).toHaveLength(401);
    expect(lines.at(-1)).toBe("(5 further locations omitted from this list)");
  });
});

describe("resolveSuggestedLocation", () => {
  const candidates = [
    candidate({
      id: "LOC-2222",
      name: "PACKOUT Wall",
      ancestors: [
        {
          id: testShortcode("location", "LOC-AAAA"),
          name: "Garage",
          type: "room",
        },
      ],
    }),
    candidate({ id: "LOC-3333", name: "Empty Bin" }),
  ];

  it("returns the candidate's own shortcode and name, not the model's string", () => {
    expect(
      resolveSuggestedLocation(candidates, aiResult("  loc-2222 ")),
    ).toEqual({
      location: {
        id: "LOC-2222",
        name: "PACKOUT Wall",
        type: "shelf",
        // The chain comes back too: without it the picker renders a bare name,
        // and same-named shelves are indistinguishable once accepted.
        ancestors: [{ id: "LOC-AAAA", name: "Garage", type: "room" }],
      },
      confidence: "high",
      reasoning: "It is the PACKOUT wall.",
    });
  });

  it("throws rather than passing through a code that names no candidate", () => {
    expect(() =>
      resolveSuggestedLocation(candidates, aiResult("LOC-9999")),
    ).toThrow(/LOC-9999/);
  });

  // A near-miss must fail like any other miss: guessing which location was
  // meant is exactly what this function refuses to do.
  it("does not prefix-match a truncated code", () => {
    expect(
      () => resolveSuggestedLocation(candidates, aiResult("LOC-222")),
      // oxlint-disable-next-line vitest/require-to-throw-message -- The rejection itself is contractual; the exact message is intentionally not.
    ).toThrow();
  });
});
