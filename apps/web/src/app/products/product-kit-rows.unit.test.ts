import { unsafeProductShortcode } from "@cubby/schemas/identifiers";
import type { ProductListItem } from "@cubby/schemas/product";
import type { KitComponentRowOut } from "@cubby/schemas/product-components";
import { describe, expect, it } from "vitest";
import {
  buildProductTreeRows,
  groupComponentsByParent,
  isKitComponentRow,
  productTreeSubRows,
} from "./product-kit-rows";

// Only the fields the row builder reads; the rest of the list row is carried
// through by spread and is not this module's concern.
const productAt = (shortcode: string, componentCount = 0) =>
  ({
    id: unsafeProductShortcode(shortcode),
    name: `Product ${shortcode}`,
    componentCount,
  }) as unknown as ProductListItem;

const componentOf = (parent: string, child: string, quantity = 1) =>
  ({
    parentProductId: unsafeProductShortcode(parent),
    quantity,
    product: productAt(child),
  }) as unknown as KitComponentRowOut;

describe("buildProductTreeRows", () => {
  it("namespaces child ids by parent so a shared component never collides", () => {
    // The hazard this exists for: a component can sit in several kits AND
    // appear as its own top-level row. `useEntityList` keys rows by `id`, so a
    // bare shortcode would make those rows share expansion and React keys.
    const rows = buildProductTreeRows(
      [
        productAt("PRD-KITA", 1),
        productAt("PRD-KITB", 1),
        productAt("PRD-SHRD"),
      ],
      groupComponentsByParent([
        componentOf("PRD-KITA", "PRD-SHRD"),
        componentOf("PRD-KITB", "PRD-SHRD"),
      ]),
    );

    const childIds = rows.flatMap((row) => row.subRows ?? []).map((r) => r.id);
    expect(childIds).toEqual(["PRD-KITA:PRD-SHRD", "PRD-KITB:PRD-SHRD"]);
    expect(new Set(childIds).size).toBe(2);
    // ...and none of them collides with the component's own top-level row.
    expect(childIds).not.toContain("PRD-SHRD");
    expect(rows.map((r) => r.id)).toContain("PRD-SHRD");
  });

  it("keeps the real shortcode on every row, at both depths", () => {
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1)],
      groupComponentsByParent([componentOf("PRD-KITA", "PRD-PART")]),
    );

    expect(rows[0]?.productId).toBe("PRD-KITA");
    // Links and per-row actions read `productId`; `id` would send them to
    // `/products/PRD-KITA:PRD-PART`.
    expect(rows[0]?.subRows?.[0]?.productId).toBe("PRD-PART");
  });

  it("omits subRows entirely when a product has no components", () => {
    // Not an empty array: `getCanExpand()` must be false so the name column
    // renders its leaf spacer instead of a chevron that opens nothing.
    const [row] = buildProductTreeRows(
      [productAt("PRD-PLAIN")],
      groupComponentsByParent([]),
    );
    expect(row && "subRows" in row).toBe(false);
    expect(productTreeSubRows(row!)).toBeUndefined();
  });

  it("carries each parent's own edge quantity", () => {
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1), productAt("PRD-KITB", 1)],
      groupComponentsByParent([
        componentOf("PRD-KITA", "PRD-SHRD", 2),
        componentOf("PRD-KITB", "PRD-SHRD", 1),
      ]),
    );
    expect(rows[0]?.subRows?.[0]?.componentQuantity).toBe(2);
    expect(rows[1]?.subRows?.[0]?.componentQuantity).toBe(1);
  });

  it("distinguishes a component row from a top-level row", () => {
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1)],
      groupComponentsByParent([componentOf("PRD-KITA", "PRD-PART")]),
    );
    // Drives `rowIsEntity`, which turns selection and the row-action menu off
    // for children — every mutation on this table targets a product id, and a
    // namespaced one was never minted by any endpoint.
    expect(isKitComponentRow(rows[0]!)).toBe(false);
    expect(isKitComponentRow(rows[0]!.subRows![0]!)).toBe(true);
  });

  it("nests one level only — a component never gets children", () => {
    // A component is allowed to be a kit (zero are today), but expansion stops
    // at depth 1, so a child must never carry subRows of its own.
    const rows = buildProductTreeRows(
      [productAt("PRD-KITA", 1)],
      groupComponentsByParent([componentOf("PRD-KITA", "PRD-KITB")]),
    );
    expect(productTreeSubRows(rows[0]!.subRows![0]!)).toBeUndefined();
  });
});
