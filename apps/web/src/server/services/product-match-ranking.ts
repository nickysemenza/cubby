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

/**
 * One unfocused queue read's cost and blind spots, for logs. A photo Product
 * outside the seed window that shares no name token with any purchase can
 * never be paired; `unseededPhotosWithoutCandidate` counts exactly those, the
 * evidence needed before widening, caching, or moving detection to write time.
 */
export function matchReadCoverage(input: {
  photoIds: readonly string[];
  purchaseCount: number;
  seeds: readonly string[];
  semanticUsed: boolean;
  pairs: readonly {
    photoId: string;
    purchaseId: string;
    source: "token" | "semantic";
  }[];
  returned: number;
  queueLimit: number;
}) {
  const seeded = new Set(input.seeds);
  const paired = new Set(input.pairs.map((pair) => pair.photoId));
  const unpaired = input.photoIds.filter((id) => !paired.has(id));
  return {
    photoProducts: input.photoIds.length,
    purchaseProducts: input.purchaseCount,
    vectorLookups: input.semanticUsed ? input.seeds.length : 0,
    unseededPhotoProducts: input.photoIds.filter((id) => !seeded.has(id))
      .length,
    tokenPairs: input.pairs.filter((pair) => pair.source === "token").length,
    semanticPairs: input.pairs.filter((pair) => pair.source === "semantic")
      .length,
    photosWithoutCandidate: unpaired.length,
    unseededPhotosWithoutCandidate: unpaired.filter((id) => !seeded.has(id))
      .length,
    returned: input.returned,
    truncated: input.returned >= input.queueLimit,
  };
}
