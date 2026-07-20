/**
 * Service for importing images from external sources (UPC lookup, recipe
 * scrape, etc.)
 *
 * Each function here combines "resolve a source URL" + image import + entity
 * association in a single operation.
 */

import type { ProductId, RecipeId } from "@cubby/schemas/identifiers";
import { env } from "~/env";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import {
  associateImagesWithProduct,
  associateImagesWithRecipe,
  recipeHasImages,
} from "~/server/repo/image";
import { importImageFromUrl } from "~/server/services/image-storage.service";

/**
 * Import an image from UPC lookup and associate it with a product.
 *
 * This function:
 * 1. Looks up the UPC to get the imageUrl
 * 2. If imageUrl exists, imports the image to R2
 * 3. Associates the image with the product
 *
 * @param db Database client
 * @param upcLookupClient UPC lookup client instance
 * @param upc UPC code to look up
 * @param productId Product ID to associate the image with
 * @returns Object with imageId, or null on failure
 */
export const importImageFromUPC = async (
  db: Database,
  upcLookupClient: UPCLookupClient,
  upc: string,
  productId: ProductId,
): Promise<{ imageId: string } | null> => {
  try {
    // 1. Look up UPC to get image URL
    const upcData = await upcLookupClient.lookup(upc);

    if (!upcData?.imageUrl) {
      return null;
    }

    // 2. Construct full URL from relative URL
    // UPC worker returns relative URLs like "/images/123456789012.jpg"
    const fullImageUrl = new URL(
      upcData.imageUrl,
      env.UPC_LOOKUP_API_URL,
    ).toString();

    // 3. Import the image to R2 and create image record
    const imported = await importImageFromUrl(db, {
      sourceUrl: fullImageUrl,
      filenamePrefix: `upc-${upc}`,
    });

    if (!imported) {
      console.warn(
        `[importImageFromUPC] Failed to import image for UPC ${upc}`,
      );
      return null;
    }

    // 4. Associate image with product
    await associateImagesWithProduct(db, productId, [imported.imageId]);

    return { imageId: imported.imageId };
  } catch (error) {
    console.error(
      `[importImageFromUPC] Error importing image for UPC ${upc}:`,
      error,
    );
    return null;
  }
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
): Promise<{ imageId: string } | null> => {
  try {
    if (await recipeHasImages(db, recipeId)) {
      return null;
    }

    const imported = await importImageFromUrl(db, {
      sourceUrl,
      filenamePrefix: `recipe-${recipeId}`,
    });

    if (!imported) {
      console.warn(
        `[importRecipeImageFromUrl] Failed to import image for recipe ${recipeId}`,
      );
      return null;
    }

    await associateImagesWithRecipe(db, recipeId, [imported.imageId]);

    return { imageId: imported.imageId };
  } catch (error) {
    console.error(
      `[importRecipeImageFromUrl] Error importing image for recipe ${recipeId}:`,
      error,
    );
    return null;
  }
};
