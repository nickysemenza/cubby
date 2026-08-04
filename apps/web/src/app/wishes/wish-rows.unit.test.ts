import {
  unsafeProductShortcode,
  unsafeWishShortcode,
} from "@cubby/schemas/identifiers";
import type { WishCandidateOut, WishOut } from "@cubby/schemas/wish";
import { describe, expect, it } from "vitest";
import { wishPriceRange } from "./wish-price-range";
import { buildWishRows, wishSubRows } from "./wish-rows";

const candidate = (
  shortcode: string,
  price: number | null,
): WishCandidateOut => ({
  id: unsafeProductShortcode(shortcode),
  name: `Product ${shortcode}`,
  manufacturer: "Acme",
  model: null,
  price,
  inventoried: false,
});

const wish = (
  shortcode: string,
  candidates: WishCandidateOut[] = [],
): WishOut => ({
  id: unsafeWishShortcode(shortcode),
  name: `Wish ${shortcode}`,
  notes: null,
  acquiredAt: null,
  candidates,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
});

describe("buildWishRows", () => {
  it("namespaces candidate row ids by their parent wish", () => {
    // The same Product on two wishes: `useEntityList` keys rows (and therefore
    // expansion, selection, and virtualizer measurements) by id, so a bare
    // product shortcode would make the two wishes share row state.
    const shared = candidate("PRD-AAAA", 10);
    const rows = buildWishRows([
      wish("WSH-0001", [shared]),
      wish("WSH-0002", [shared]),
    ]);

    const childIds = rows.flatMap((row) =>
      row.kind === "wish" ? row.subRows.map((child) => child.id) : [],
    );
    expect(childIds).toEqual(["WSH-0001:PRD-AAAA", "WSH-0002:PRD-AAAA"]);
    expect(new Set(childIds).size).toBe(2);
  });

  it("keeps the product's own shortcode for the detail link", () => {
    const [row] = buildWishRows([wish("WSH-0001", [candidate("PRD-BBBB", 5)])]);
    const child = row?.kind === "wish" ? row.subRows[0] : undefined;
    expect(child?.kind === "candidate" && child.productId).toBe("PRD-BBBB");
  });

  it("gives a candidate-less wish no sub-rows, so it renders no chevron", () => {
    const rows = buildWishRows([wish("WSH-0003")]);
    // `getCanExpand()` is false for an empty array, which is what keeps a
    // chevron that opens nothing off the row.
    expect(wishSubRows(rows[0]!)).toEqual([]);
  });

  it("returns undefined sub-rows for a candidate row", () => {
    const [row] = buildWishRows([wish("WSH-0004", [candidate("PRD-CCCC", 1)])]);
    const child = row?.kind === "wish" ? row.subRows[0]! : undefined;
    expect(wishSubRows(child!)).toBeUndefined();
  });
});

describe("wishPriceRange", () => {
  it("spans the priced candidates and counts them", () => {
    expect(
      wishPriceRange([
        candidate("PRD-A", 200),
        candidate("PRD-B", 650),
        candidate("PRD-C", 425),
      ]),
    ).toEqual({ low: 200, high: 650, pricedCount: 3 });
  });

  it("collapses a lone candidate to an equal low and high", () => {
    expect(wishPriceRange([candidate("PRD-A", 425)])).toEqual({
      low: 425,
      high: 425,
      pricedCount: 1,
    });
  });

  it("excludes unpriced candidates instead of treating them as free", () => {
    expect(
      wishPriceRange([candidate("PRD-A", 200), candidate("PRD-B", null)]),
    ).toEqual({ low: 200, high: 200, pricedCount: 1 });
  });

  it("is null when nothing is priced", () => {
    expect(wishPriceRange([candidate("PRD-A", null)])).toBeNull();
    expect(wishPriceRange([])).toBeNull();
  });
});
