/**
 * Image utility functions
 */

/**
 * Check if an image URL is from a UPC lookup service.
 * These images are managed separately and should be excluded from exports.
 */
export function isUpcImage(url: string): boolean {
  return url.includes("/upc-");
}

/**
 * Filter out UPC-fetched images from an array of image objects.
 * Use this when exporting images to ensure only user-managed images are included.
 */
function filterUserManagedImages<T extends { image: { url: string } }>(
  images: T[] | undefined | null,
): T[] {
  if (!images || images.length === 0) return [];
  return images.filter((i) => !isUpcImage(i.image.url));
}

/**
 * Join image URLs into a semicolon-separated string for CSV export.
 * Automatically filters out UPC-fetched images.
 */
export function joinImageUrls<T extends { image: { url: string } }>(
  images: T[] | undefined | null,
): string | null {
  const filtered = filterUserManagedImages(images);
  if (filtered.length === 0) return null;
  return filtered.map((i) => i.image.url).join("; ");
}
