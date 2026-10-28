import { z } from "zod";
import {
  wishFilterFields as wishBaseFilterFields,
  wishOut,
} from "@cubby/schemas/entities/wish";

export { wishCandidateOut, type WishCandidateOut } from "./wish-fields";
import { createPaginatedResponseSchema } from "./pagination";

export const wishFilterFields = wishBaseFilterFields;
export const wishFiltersSchema = z.object(wishFilterFields);
export type WishFilters = z.infer<typeof wishFiltersSchema>;

// `priceRange` is not a Wish column: an aggregate over candidate prices,
// ordered by the range midpoint via `resolveWishSort` in `server/domains/wish/repo.ts`.
export const wishListOut = createPaginatedResponseSchema(wishOut);
