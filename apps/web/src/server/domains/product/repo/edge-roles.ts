/** Product retention uses the acquisition/history roles emitted from edge declarations.
 * Orphan detection and deletion share this allowlist; adding another role does
 * not grant it authority to retain a Product.
 */
import { ENTITY_EDGE_SEMANTICS } from "~/server/db/entity-edge-semantics";

export const PRODUCT_EDGE_ROLES = ENTITY_EDGE_SEMANTICS.product;

const RETAINING_ROLES = [
  "acquisition",
  "history",
  "association",
  "reference",
  "usage",
] as const;
type RetainingRole = (typeof RETAINING_ROLES)[number];

/**
 * The subset of `product`'s incoming edges whose role retains the product.
 * Derived from {@link PRODUCT_EDGE_ROLES}, not hand-listed, so it can't drift
 * from it. Both `findOrphanedProducts` and `deleteProducts` key their own
 * per-edge SQL map off this type.
 */
export type ProductRetainingEdgeKey = {
  [
    K in keyof typeof PRODUCT_EDGE_ROLES
  ]: (typeof PRODUCT_EDGE_ROLES)[K]["role"] extends RetainingRole ? K : never;
}[keyof typeof PRODUCT_EDGE_ROLES];

const isProductEdgeKey = (
  key: string,
): key is keyof typeof PRODUCT_EDGE_ROLES =>
  Object.hasOwn(PRODUCT_EDGE_ROLES, key);

export const isRetainingEdgeKey = (
  key: string,
): key is ProductRetainingEdgeKey =>
  isProductEdgeKey(key) &&
  RETAINING_ROLES.some((role) => role === PRODUCT_EDGE_ROLES[key].role);
