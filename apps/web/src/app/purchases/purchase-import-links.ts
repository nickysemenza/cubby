export function importRunHref(publicId: string): string {
  return `/import-runs/${encodeURIComponent(publicId)}`;
}
