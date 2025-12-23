/**
 * Image handler for CSV import
 *
 * Handles downloading external images and associating them with products and locations.
 * Supports multiple images as semicolon-separated URLs.
 */

import { type Database } from "~/server/db";
import {
  type ProductId,
  type OrganizationId,
  type LocationId,
} from "~/schemas/identifiers";
import { importImageFromUrl } from "~/server/repo/image";
import { getDb, associatePendingImages } from "~/server/repo/database-helpers";
import { productImage, locationImage, image } from "~/server/db/schema";
import { eq, count } from "drizzle-orm";
import { isUpcImage } from "~/lib/image-utils";

/**
 * Parse semicolon-separated image URLs into an array
 */
function parseImageUrls(imageUrlString: string | undefined | null): string[] {
  if (!imageUrlString) return [];
  return imageUrlString
    .split(";")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Check if a product already has images
 */
export async function productHasImages(
  db: Database,
  productId: ProductId,
): Promise<boolean> {
  const result = await getDb(db)
    .select({ count: count() })
    .from(productImage)
    .where(eq(productImage.productId, productId));
  return (result[0]?.count ?? 0) > 0;
}

/**
 * Check if a product already has a UPC-fetched image.
 * UPC images have URLs containing "/upc-" in the path.
 */
export async function productHasUPCImage(
  db: Database,
  productId: ProductId,
): Promise<boolean> {
  const dbClient = getDb(db);

  // Join productImage with image to check the URL pattern
  const result = await dbClient
    .select({ url: image.url })
    .from(productImage)
    .innerJoin(image, eq(productImage.imageId, image.id))
    .where(eq(productImage.productId, productId));

  // Check if any image URL matches the UPC pattern
  return result.some((r) => isUpcImage(r.url));
}

/**
 * Import result for multiple images
 */
interface ImageImportResult {
  success: boolean;
  skipped?: boolean;
  imported: number;
  failed: number;
  error?: string;
}

/**
 * Import images from semicolon-separated URLs and associate with a product.
 * Skips if the product already has images.
 */
export async function importProductImages(
  db: Database,
  organizationId: OrganizationId,
  productId: ProductId,
  imageUrlString: string,
  productName: string,
): Promise<ImageImportResult> {
  // Skip if product already has images
  const hasImages = await productHasImages(db, productId);
  if (hasImages) {
    return { success: true, skipped: true, imported: 0, failed: 0 };
  }

  const urls = parseImageUrls(imageUrlString);
  if (urls.length === 0) {
    return { success: true, imported: 0, failed: 0 };
  }

  // Generate filename prefix from product name (sanitized)
  const sanitizedName = productName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);

  const imageIds: string[] = [];
  const errors: string[] = [];

  // Import each image
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const filenamePrefix = `product-${sanitizedName}-${i + 1}`;

    try {
      const imported = await importImageFromUrl(db, organizationId, {
        sourceUrl: url,
        filenamePrefix,
      });

      if (imported) {
        imageIds.push(imported.imageId);
      } else {
        errors.push(`Image ${i + 1}: Failed to download`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`Image ${i + 1}: ${message}`);
    }
  }

  // Associate all successfully imported images with product
  if (imageIds.length > 0) {
    await associatePendingImages(
      getDb(db),
      productImage,
      "productId",
      productId,
      imageIds,
    );
  }

  return {
    success: errors.length === 0,
    imported: imageIds.length,
    failed: errors.length,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

/**
 * Check if a location already has images
 */
export async function locationHasImages(
  db: Database,
  locationId: LocationId,
): Promise<boolean> {
  const result = await getDb(db)
    .select({ count: count() })
    .from(locationImage)
    .where(eq(locationImage.locationId, locationId));
  return (result[0]?.count ?? 0) > 0;
}

/**
 * Import images from semicolon-separated URLs and associate with a location.
 * Skips if the location already has images.
 */
export async function importLocationImages(
  db: Database,
  organizationId: OrganizationId,
  locationId: LocationId,
  imageUrlString: string,
  locationName: string,
): Promise<ImageImportResult> {
  // Skip if location already has images
  const hasImages = await locationHasImages(db, locationId);
  if (hasImages) {
    return { success: true, skipped: true, imported: 0, failed: 0 };
  }

  const urls = parseImageUrls(imageUrlString);
  if (urls.length === 0) {
    return { success: true, imported: 0, failed: 0 };
  }

  // Generate filename prefix from location name (sanitized)
  const sanitizedName = locationName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 50);

  const imageIds: string[] = [];
  const errors: string[] = [];

  // Import each image
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const filenamePrefix = `location-${sanitizedName}-${i + 1}`;

    try {
      const imported = await importImageFromUrl(db, organizationId, {
        sourceUrl: url,
        filenamePrefix,
      });

      if (imported) {
        imageIds.push(imported.imageId);
      } else {
        errors.push(`Image ${i + 1}: Failed to download`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      errors.push(`Image ${i + 1}: ${message}`);
    }
  }

  // Associate all successfully imported images with location
  if (imageIds.length > 0) {
    await associatePendingImages(
      getDb(db),
      locationImage,
      "locationId",
      locationId,
      imageIds,
    );
  }

  return {
    success: errors.length === 0,
    imported: imageIds.length,
    failed: errors.length,
    error: errors.length > 0 ? errors.join("; ") : undefined,
  };
}

/**
 * Preview what would happen with product image import (for dry-run mode)
 */
export async function previewProductImages(
  db: Database,
  productId: ProductId | null,
  imageUrlString: string | undefined | null,
): Promise<{
  imageWillBeImported?: string;
  imageCount?: number;
  imageImportSkipped?: boolean;
}> {
  const urls = parseImageUrls(imageUrlString);
  if (urls.length === 0) {
    return {};
  }

  // For new products, images will always be imported
  if (!productId) {
    return {
      imageWillBeImported: imageUrlString ?? undefined,
      imageCount: urls.length,
    };
  }

  // For existing products, check if they already have images
  const hasImages = await productHasImages(db, productId);
  if (hasImages) {
    return { imageImportSkipped: true };
  }

  return {
    imageWillBeImported: imageUrlString ?? undefined,
    imageCount: urls.length,
  };
}

/**
 * Preview what would happen with location image import (for dry-run mode)
 */
export async function previewLocationImages(
  db: Database,
  locationId: LocationId | null,
  imageUrlString: string | undefined | null,
): Promise<{
  locationImageWillBeImported?: string;
  locationImageCount?: number;
  locationImageImportSkipped?: boolean;
}> {
  const urls = parseImageUrls(imageUrlString);
  if (urls.length === 0) {
    return {};
  }

  // For new locations (will be created), images will be imported
  if (!locationId) {
    return {
      locationImageWillBeImported: imageUrlString ?? undefined,
      locationImageCount: urls.length,
    };
  }

  // For existing locations, check if they already have images
  const hasImages = await locationHasImages(db, locationId);
  if (hasImages) {
    return { locationImageImportSkipped: true };
  }

  return {
    locationImageWillBeImported: imageUrlString ?? undefined,
    locationImageCount: urls.length,
  };
}
