/**
 * Service for importing images from external sources (UPC lookup, etc.)
 *
 * This service combines UPC lookup + image import + association in a single operation.
 */

import { env } from "~/env";
import type { ProductId } from "~/schemas/identifiers";
import type { UPCLookupClient } from "~/server/clients/upc-lookup";
import type { Database } from "~/server/db";
import {
  associateImagesWithProduct,
  importImageFromUrl,
} from "~/server/repo/image";

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
