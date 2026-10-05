import type { ArchiveImageRef, CookbookRecipe } from "@cubby/schemas/cookbook";

/**
 * The photo a recipe item imports: its FIRST, which the crate documents as the
 * hero shot. `attachCookbookRecipePhoto` attaches exactly that one, so the
 * preview must show the same image the import will store.
 */
export const heroPhoto = (
  item: CookbookRecipe | undefined,
): ArchiveImageRef | undefined => item?.photos[0];

/**
 * Of the given tree item ids, the ones whose recipe has a photo to read out of
 * the EPUB archive. Ids, not positions: re-extracting a book keeps item ids
 * stable but not array order, and a photo attached to the wrong recipe is worse
 * than no photo at all.
 */
export const selectedPhotoItemIds = (
  recipesById: ReadonlyMap<string, CookbookRecipe>,
  ids: readonly string[],
): string[] => ids.filter((id) => heroPhoto(recipesById.get(id)) !== undefined);
