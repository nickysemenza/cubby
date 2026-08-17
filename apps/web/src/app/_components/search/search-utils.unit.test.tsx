import type { SearchHit } from "@cubby/schemas/search";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchResultMedia } from "./search-utils";

/**
 * `SearchDocument.typeHint` is a denormalized snapshot, so a row keeps whatever
 * type string it was written with until it is reindexed — the location enum
 * went 16 → 9 and left `crate`, `quarter-crate`, `tote-27gal`, … on live rows.
 * Casting one of those into the exhaustive icon Record yields `undefined`, and
 * rendering `<undefined />` threw React error #130, blanking the command menu
 * and /search for any query that surfaced such a row (production hit it on
 * "quarter"). These pin the fallback rather than the specific icon.
 */
function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    id: "LOC-1111",
    entityType: "location",
    title: "<location>",
    subtitle: null,
    typeHint: null,
    imageUrl: null,
    matchKind: "exact",
    matchField: "title",
    matchReason: "",
    matchTerms: [],
    ...overrides,
  } as SearchHit;
}

describe("SearchResultMedia", () => {
  it("renders a retired location typeHint instead of throwing", () => {
    const { container } = render(
      <SearchResultMedia item={hit({ typeHint: "quarter-crate" })} />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("renders an unknown product category instead of throwing", () => {
    const { container } = render(
      <SearchResultMedia
        item={hit({ entityType: "product", id: "PRD-2222", typeHint: "gone" })}
      />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });

  it("still uses the type-specific icon for a live typeHint", () => {
    const { container } = render(
      <SearchResultMedia item={hit({ typeHint: "shelf" })} />,
    );
    expect(container.querySelector("svg")).not.toBeNull();
  });
});
