import { testShortcode } from "@cubby/schemas/testing";
import { describe, expect, it } from "vitest";

import type { LocationPutAwayCandidate } from "~/server/repo/location";

import { locationSuggestionSpec } from "./location-suggest";

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

// `resolveSuggestedLocation`'s old id-matching and rejection behavior now
// lives in `runAiSelection`'s generic guard, and shaping the outcome now
// lives in `server/ai/field-suggest/suggest-fields.ts`; these pin the
// spec's own half of the contract — the line format and id extraction
// `runAiSelection` drives that guard with.
describe("locationSuggestionSpec", () => {
  it("renders the ancestor chain so same-named shelves are distinguishable", () => {
    const line = locationSuggestionSpec.renderLine(
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
    );

    expect(line).toBe(
      `${testShortcode("location", "LOC-1111")} | Garage > Shelving Unit > Shelf 3 (shelf) - 12 items`,
    );
  });

  it("prints only the hints that carry evidence", () => {
    const line = locationSuggestionSpec.renderLine(
      candidate({
        id: "LOC-2222",
        name: "PACKOUT Wall",
        itemCount: 9,
        tagSiblings: 3,
        categorySiblings: 7,
        holdsProduct: true,
      }),
    );

    expect(line).toBe(
      "LOC-2222 | PACKOUT Wall (shelf) - 9 items; already stocked here, 3 share tags, 7 same category",
    );
    // No zero-valued hints, and an unstocked location still gets offered.
    expect(
      locationSuggestionSpec.renderLine(
        candidate({ id: "LOC-3333", name: "Empty Bin" }),
      ),
    ).toBe("LOC-3333 | Empty Bin (shelf) - 0 items");
  });

  it("omits the type when a location has none", () => {
    const line = locationSuggestionSpec.renderLine(
      candidate({ id: "LOC-4444", name: "Red Crate", type: null }),
    );

    expect(line).toBe("LOC-4444 | Red Crate - 0 items");
  });

  it("extracts the candidate's own shortcode as the selection id", () => {
    const packoutWall = candidate({ id: "LOC-2222", name: "PACKOUT Wall" });
    expect(locationSuggestionSpec.idOf(packoutWall)).toBe("LOC-2222");
  });

  it("caps the shortlist at 400 locations", () => {
    expect(locationSuggestionSpec.maxCandidates).toBe(400);
  });
});
