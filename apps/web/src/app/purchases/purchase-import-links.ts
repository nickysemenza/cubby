export function purchaseImportRunHref(publicId: string): string {
  return `/purchase-imports/${encodeURIComponent(publicId)}`;
}
