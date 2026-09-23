import type { WishCandidateOut, WishListItemOut } from "@cubby/schemas/wish";

/**
 * A row in the wishlist table: either a Wish, or one of its candidate
 * Products nested beneath it.
 *
 * The two are a discriminated union rather than one widened shape so every
 * column has to say what it renders for a candidate — a Status badge or an
 * Options count on a Product row would be a category error, not a blank cell.
 *
 * Candidate ids are namespaced by their parent wish because one Product can be
 * a candidate on several wishes; `useEntityList` keys rows (and therefore
 * virtualizer measurements, expansion, and selection) by `id`, so the bare
 * product shortcode would make those wishes share row state. `productId` keeps
 * the real shortcode for the detail link.
 */
export type WishRow =
  | {
      kind: "wish";
      id: string;
      entityType: "wish";
      previewId: WishListItemOut["id"];
      name: string;
      wish: WishListItemOut;
      subRows: WishRow[];
    }
  | {
      kind: "candidate";
      id: string;
      entityType: "product";
      previewId: WishCandidateOut["id"];
      name: string;
      productId: WishCandidateOut["id"];
      candidate: WishCandidateOut;
    };

/**
 * Nest each wish's candidates as its child rows.
 *
 * A wish with no candidates gets no `subRows`, so TanStack's `getCanExpand()`
 * is false and the name column renders its leaf spacer instead of a chevron
 * that opens nothing.
 */
export const buildWishRows = (wishes: readonly WishListItemOut[]): WishRow[] =>
  wishes.map((wish) => ({
    kind: "wish",
    id: wish.id,
    entityType: "wish",
    previewId: wish.id,
    name: wish.name,
    wish,
    subRows: wish.candidates.map((candidate) => ({
      kind: "candidate",
      id: `${wish.id}:${candidate.id}`,
      entityType: "product",
      previewId: candidate.id,
      name: candidate.name,
      productId: candidate.id,
      candidate,
    })),
  }));

export const wishSubRows = (row: WishRow): WishRow[] | undefined =>
  row.kind === "wish" ? row.subRows : undefined;
