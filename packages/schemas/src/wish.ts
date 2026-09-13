import { z } from "zod";
import { auditDateFilterFields } from "./base-entity";
import {
  generatedWishFieldSchemas,
  generatedWishFilterFields,
} from "./generated/entity-field-schemas.wish.gen";
import { productShortcode, wishShortcode } from "./identifiers";
export { wishCandidateOut, type WishCandidateOut } from "./wish-fields";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import { wishRelatedFilterFields } from "./related-view";
import { displayImagesField } from "./image-summary";

export const wishCreateInput = z.object(generatedWishFieldSchemas.create);
export type WishCreateInput = z.infer<typeof wishCreateInput>;

export const wishUpdateData = z.object(generatedWishFieldSchemas.update);
export type WishUpdateData = z.infer<typeof wishUpdateData>;

export const wishUpdateInput = z.object({
  id: wishShortcode,
  data: wishUpdateData,
});
export type WishUpdateInput = z.infer<typeof wishUpdateInput>;

export const wishOut = z.object({
  ...generatedWishFieldSchemas.read,
});
export type WishOut = z.infer<typeof wishOut>;

export const wishListItemOut = wishOut.extend({
  displayImages: displayImagesField,
});
export type WishListItemOut = z.infer<typeof wishListItemOut>;

export const wishFilterFields = {
  ...auditDateFilterFields,
  ...wishRelatedFilterFields,
  ...generatedWishFilterFields,
  candidateProductId: oneOrMany(productShortcode).optional(),
};
export const wishFiltersSchema = z.object(wishFilterFields);
export type WishFilters = z.infer<typeof wishFiltersSchema>;

// `priceRange` is not a Wish column: an aggregate over candidate prices,
// ordered by the range midpoint via `resolveWishSort` in `server/repo/wish.ts`.
export const wishListOut = createPaginatedResponseSchema(wishOut);
