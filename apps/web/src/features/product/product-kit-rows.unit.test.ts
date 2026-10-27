import type { EntityFieldEnvelopeRead } from "@cubby/schemas/entity-field-envelopes";
import type { KitComponentRowOut } from "@cubby/schemas/product-components";
import { testShortcode } from "@cubby/schemas/testing";
import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, it } from "vitest";

import {
  buildProductTreeRows,
  groupComponentsByParent,
  isKitComponentRow,
  productTreeSubRows,
} from "./product-kit-rows";

const productId = (seed: string) => testShortcode("product", seed);

const productAt = (shortcode: string, componentCount = 0) =>
  fromPartial<EntityFieldEnvelopeRead<"product", "list">>({
    id: testShortcode("product", shortcode),
    name: `Synthetic product ${shortcode}`,
    fields: {
      componentCount: {
        current: {
          assignment: null,
          controls: { kind: "readonly", reason: "computed" },
        },
        result: {
          kind: "live",
          decision: {
            outcome: { kind: "value", value: componentCount },
            provenance: { kind: "computed" },
          },
        },
        work: { kind: "idle" },
      },
    },
  });

const componentOf = (
  parent: string,
  child: string,
  quantity = 1,
): KitComponentRowOut => ({
  parentProductId: testShortcode("product", parent),
  quantity,
  product: productAt(child),
});

describe("buildProductTreeRows", () => {
  it("namespaces child ids by parent so a shared component never collides", () => {
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

    const childKeys = rows
      .flatMap((row) => row.subRows ?? [])
      .map((r) => r.rowKey);
    expect(childKeys).toEqual([
      `${productId("PRD-KITA")}:${productId("PRD-SHRD")}`,
      `${productId("PRD-KITB")}:${productId("PRD-SHRD")}`,
    ]);
    expect(new Set(childKeys).size).toBe(2);
    expect(childKeys).not.toContain(productId("PRD-SHRD"));
    expect(rows.map((r) => r.rowKey)).toContain(productId("PRD-SHRD"));
  });

  it("omits subRows entirely when a product has no components", () => {
    // Not an empty array: `getCanExpand()` must be false so the name column
    // renders no chevron that opens nothing.
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
