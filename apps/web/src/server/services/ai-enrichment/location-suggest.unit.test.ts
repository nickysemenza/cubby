import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import type { LocationPutAwayCandidate } from "~/server/repo/location";

import {
  formatLocationCandidates,
  locationSuggestionSpec,
  resolveLocationSuggestion,
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

// `resolveSuggestedLocation`'s old id-matching and rejection behavior now
// lives in `runAiSelection`'s generic guard; these pin the spec's own half
// of the contract — the line format and id extraction `runAiSelection`
// drives that guard with.
describe("locationSuggestionSpec", () => {
  const packoutWall = candidate({
    id: "LOC-2222",
    name: "PACKOUT Wall",
    ancestors: [
      {
        id: testShortcode("location", "LOC-AAAA"),
        name: "Garage",
        type: "room",
      },
    ],
  });

  it("renders one candidate the same way formatLocationCandidates does", () => {
    expect(locationSuggestionSpec.renderLine(packoutWall)).toBe(
      formatLocationCandidates([packoutWall]),
    );
  });

  it("extracts the candidate's own shortcode as the selection id", () => {
    expect(locationSuggestionSpec.idOf(packoutWall)).toBe("LOC-2222");
  });

  it("caps the shortlist at 400 locations", () => {
    expect(locationSuggestionSpec.maxCandidates).toBe(400);
  });
});

describe("resolveLocationSuggestion", () => {
  const packoutWall = candidate({
    id: "LOC-2222",
    name: "PACKOUT Wall",
    ancestors: [
      {
        id: testShortcode("location", "LOC-AAAA"),
        name: "Garage",
        type: "room",
      },
    ],
  });

  it("shapes a resolved candidate into the public suggestion", () => {
    expect(
      resolveLocationSuggestion(
        {
          selected: packoutWall,
          confidence: "high",
          reasoning: "It is the PACKOUT wall.",
        },
        2,
      ),
    ).toEqual({
      location: {
        id: "LOC-2222",
        name: "PACKOUT Wall",
        type: "shelf",
        ancestors: [{ id: "LOC-AAAA", name: "Garage", type: "room" }],
      },
      confidence: "high",
      reasoning: "It is the PACKOUT wall.",
    });
  });

  // `runAiSelection`'s own guard already resolves an off-roster or invented
  // id to `selected: null` (see ai/selection.unit.test.ts); this pins what
  // happens next, at the location layer, when that guard comes back empty.
  it("throws rather than passing through a null selection", () => {
    expect(() =>
      resolveLocationSuggestion(
        { selected: null, confidence: "low", reasoning: "no match" },
        3,
      ),
    ).toThrow(/3 locations/);
  });
});
