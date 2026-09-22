export function importRunHref(publicId: string): string {
  return `/runs/${encodeURIComponent(publicId)}`;
}
