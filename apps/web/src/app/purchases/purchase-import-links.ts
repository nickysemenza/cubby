export function runHref(publicId: string): string {
  return `/runs/${encodeURIComponent(publicId)}`;
}
