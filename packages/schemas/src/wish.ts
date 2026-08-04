import { z } from "zod";
import {
  auditDateFilterFields,
  deriveUpdateData,
  timestampedFields,
} from "./base-entity";
import { productShortcode, wishShortcode } from "./identifiers";
import { createPaginatedResponseSchema, oneOrMany } from "./pagination";
import { wishRelatedFilterFields } from "./related-view";

const wishFields = {
  name: z.string().trim().min(1).max(200),
  notes: z.string().nullable(),
  candidateProductIds: z.array(productShortcode),
};

export const wishCreateInput = z.object({
  ...wishFields,
  notes: wishFields.notes.default(null),
  candidateProductIds: wishFields.candidateProductIds.default([]),
});
export type WishCreateInput = z.infer<typeof wishCreateInput>;

export const wishUpdateData = deriveUpdateData(wishFields, {
  extend: {
    /** A server-time toggle; the stored historical value is `acquiredAt`. */
    acquired: z.boolean().optional(),
  },
});
export type WishUpdateData = z.infer<typeof wishUpdateData>;

export const wishUpdateInput = z.object({
  id: wishShortcode,
  data: wishUpdateData,
});
export type WishUpdateInput = z.infer<typeof wishUpdateInput>;

export const wishCandidateOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  price: z.number().nullable(),
  inventoried: z.boolean(),
});
export type WishCandidateOut = z.infer<typeof wishCandidateOut>;

export const wishOut = z.object({
  id: wishShortcode,
  name: z.string(),
  notes: z.string().nullable(),
  acquiredAt: z.date().nullable(),
  candidates: z.array(wishCandidateOut),
  ...timestampedFields,
});
export type WishOut = z.infer<typeof wishOut>;

export const wishFilterFields = {
  ...auditDateFilterFields,
  ...wishRelatedFilterFields,
  search: z.string().trim().min(1).optional(),
  acquired: z.boolean().optional(),
  candidateProductId: oneOrMany(productShortcode).optional(),
};
export const wishFiltersSchema = z.object(wishFilterFields);
export type WishFilters = z.infer<typeof wishFiltersSchema>;

export const wishSortableFields = [
  "name",
  "acquiredAt",
  // Not a Wish column: an aggregate over candidate prices, ordered by the range
  // midpoint via `resolveWishSort` in `server/repo/wish.ts`.
  "priceRange",
  "createdAt",
  "updatedAt",
] as const;

export const wishListOut = createPaginatedResponseSchema(wishOut);
