import type { ProductId, RecipeId } from "@cubby/schemas/identifiers";

import { env } from "~/env";
import type { UpcLookupPort } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import {
  associateImagesWithProduct,
  associateImagesWithRecipe,
  recipeHasImages,
} from "~/server/repo/image";
import { importImageFromUrl } from "~/server/services/image-storage.service";

export type ImageUrlImportPort = typeof importImageFromUrl;

export interface RecipeImageImportPort {
  hasImages: typeof recipeHasImages;
  importFromUrl: ImageUrlImportPort;
  associate: typeof associateImagesWithRecipe;
}

export const productionRecipeImageImportPort: RecipeImageImportPort = {
  hasImages: recipeHasImages,
  importFromUrl: importImageFromUrl,
  associate: associateImagesWithRecipe,
};

/**
 * Import the UPC lookup's cover image and attach it to the product.
 *
 * Returns null only when the lookup has no image to import; a lookup, fetch,
 * or storage failure throws so the caller can report it (callers treat the
 * cover as best-effort and turn the error into a warning or a failed row).
 */
export const importImageFromUPC = async (
  db: Database,
  upcLookupClient: Pick<UpcLookupPort, "lookup">,
  upc: string,
  productId: ProductId,
): Promise<{ imageId: string } | null> => {
  const upcData = await upcLookupClient.lookup(upc);
  if (!upcData?.imageUrl) return null;

  const fullImageUrl = new URL(
    upcData.imageUrl,
    env.UPC_LOOKUP_API_URL,
  ).toString();
  const imported = await importImageFromUrl(db, {
    sourceUrl: fullImageUrl,
    filenamePrefix: `upc-${upc}`,
  });
  if (!imported)
    throw new Error(`No image could be fetched from ${fullImageUrl}`);

  await associateImagesWithProduct(db, productId, [imported.imageId]);
  return { imageId: imported.imageId };
};

/**
 * Import a scraped recipe's hero photo into R2 and attach it to the recipe.
 *
 * Runs inline on the server-side import path (`recipe.insertImport`, which the
 * MCP `import_recipe` / `scrape_recipe` tools drive) — the browser scrape form
 * imports its image client-side via `image.importFromUrl` instead.
 *
 * No-ops when the recipe already has an image so a re-import doesn't stack a
 * fresh R2 object every time (the upsert keys on name, and `Image` carries no
 * source URL to dedupe on). Never throws: a dead or 403 photo URL must not sink
 * the recipe import.
 */
export const importRecipeImageFromUrl = async (
  db: Database,
  recipeId: RecipeId,
  sourceUrl: string,
  port: RecipeImageImportPort = productionRecipeImageImportPort,
): Promise<{ imageId: string } | null> => {
  try {
    if (await port.hasImages(db, recipeId)) {
      return null;
    }

    const imported = await port.importFromUrl(db, {
      sourceUrl,
      filenamePrefix: `recipe-${recipeId}`,
    });

    if (!imported) {
      console.warn(
        `[importRecipeImageFromUrl] Failed to import image for recipe ${recipeId}`,
      );
      return null;
    }

    await port.associate(db, recipeId, [imported.imageId]);

    return { imageId: imported.imageId };
  } catch (error) {
    console.error(
      `[importRecipeImageFromUrl] Error importing image for recipe ${recipeId}:`,
      error,
    );
    return null;
  }
};
