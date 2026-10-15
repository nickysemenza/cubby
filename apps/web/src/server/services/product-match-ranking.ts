/** Keep own item photos first; labels remain after representative covers. */
export function matchSurvivorImageOrder<
  T extends { source: string | null; purpose: string | null },
>(images: readonly T[]): T[] {
  const bucket = (image: T) =>
    image.purpose === "label" ? 2 : image.source === "own" ? 0 : 1;
  return images
    .map((image, index) => ({ image, index }))
    .sort((a, b) => bucket(a.image) - bucket(b.image) || a.index - b.index)
    .map(({ image }) => image);
}
