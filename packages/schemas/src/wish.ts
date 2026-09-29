import { z } from "zod";
import { productShortcode } from "./identifiers";
import { wishBaseFilterFields, wishOut } from "./generated/wish.gen";

export {
  wishCreateInput,
  wishUpdateData,
  wishUpdateInput,
  wishOut,
  wishListItemOut,
  type WishCreateInput,
  type WishUpdateData,
  type WishUpdateInput,
  type WishOut,
  type WishListItemOut,
} from "./generated/wish.gen";
export { wishCandidateOut, type WishCandidateOut } from "./wish-fields";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";

export const wishFilterFields = {
  ...wishBaseFilterFields,
  candidateProductId: oneOrMany(productShortcode).optional(),
};
export const wishFiltersSchema = z.object(wishFilterFields);
export type WishFilters = z.infer<typeof wishFiltersSchema>;

// `priceRange` is not a Wish column: an aggregate over candidate prices,
// ordered by the range midpoint via `resolveWishSort` in `server/repo/wish.ts`.
export const wishListOut = createPaginatedResponseSchema(wishOut);
