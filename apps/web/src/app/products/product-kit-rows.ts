import type { ProductListItem } from "@cubby/schemas/product";
import type { KitComponentRowOut } from "@cubby/schemas/product-components";

/**
 * A row in the Products table: a product, or one of a kit's components nested
 * beneath it.
 *
 * Homogeneous, unlike the wishlist's `WishRow` union — there the children are a
 * different entity, so a Status badge on a Product row would be a category
 * error and the union forces every column to say what it renders. Here a
 * component IS a product, every column means the same thing at both depths, and
 * a union would only make ~25 accessors say `row.item.x` for no gain.
 *
 * ⚠️ Which is exactly why `id` stays the product's real shortcode. The obvious
 * shortcut — namespacing `id` so TanStack keys stay unique — silently poisons
 * every `row.id` read in the table, and the type system CANNOT catch it: a
 * branded shortcode's *input* type is a plain string, so a namespaced id
 * assigns cleanly into every mutation and link. `rowKey` carries the uniqueness
 * instead, and `useEntityList`'s `tree.rowKey` hands it to TanStack.
 */
export type ProductTreeRow = ProductListItem & {
  /**
   * Unique table row key — the shortcode at top level, `${kitId}:${id}` for a
   * component. Consumed only by `getRowId`; never a link target or a mutation
   * argument. A component can sit in several kits (10 do) and also appear as
   * its own top-level row, so `id` alone is not unique within one page.
   */
  rowKey: string;
  /** Present only on a component row; the kit it was nested under. */
  kitParentId?: ProductListItem["id"];
  /** How many of this component one unit of the kit contains. */
  componentQuantity?: number;
  subRows?: ProductTreeRow[];
};

/** A component row, as opposed to a top-level product. */
export const isKitComponentRow = (row: ProductTreeRow): boolean =>
  row.kitParentId !== undefined;

/** The table row key; see `ProductTreeRow.rowKey`. */
export const productTreeRowKey = (row: ProductTreeRow): string => row.rowKey;

/**
 * Group the batched component rows by the kit they belong to. Built once per
 * fetch so `nest` stays O(rows).
 */
export const groupComponentsByParent = (
  rows: readonly KitComponentRowOut[],
): Map<string, KitComponentRowOut[]> => {
  const byParent = new Map<string, KitComponentRowOut[]>();
  for (const row of rows) {
    const existing = byParent.get(row.parentProductId);
    if (existing) existing.push(row);
    else byParent.set(row.parentProductId, [row]);
  }
  return byParent;
};

/**
 * Nest each kit's components as its child rows.
 *
 * A product with no components gets NO `subRows` key at all, so TanStack's
 * `getCanExpand()` is false and the name column renders its leaf spacer rather
 * than a chevron that opens nothing. That distinction is why this returns the
 * row unchanged instead of attaching an empty array.
 *
 * Components are never given `subRows` themselves: nesting is one level. The
 * write path permits a component to be a kit, but zero are, and a child row
 * would need its own component count to know whether to draw a chevron.
 */
export const buildProductTreeRows = (
  items: readonly ProductListItem[],
  componentsByParent: Map<string, KitComponentRowOut[]>,
): ProductTreeRow[] =>
  items.map((item) => {
    const components = componentsByParent.get(item.id);
    const row: ProductTreeRow = { ...item, rowKey: item.id };
    if (!components || components.length === 0) return row;
    return {
      ...row,
      subRows: components.map((component) => ({
        ...component.product,
        rowKey: `${item.id}:${component.product.id}`,
        kitParentId: item.id,
        componentQuantity: component.quantity,
      })),
    };
  });

export const productTreeSubRows = (
  row: ProductTreeRow,
): ProductTreeRow[] | undefined => row.subRows;
