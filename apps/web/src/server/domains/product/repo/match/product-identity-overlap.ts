/**
 * The relevance gate shared by Product candidate lookups: a candidate counts
 * only with an exact identifier, or by sharing identity words beyond the
 * brand — one when the brand matches, two otherwise.
 */

/** Splits compact vendor titles like `ForgeWearMenPocketShirtBlackSmall`. */
export function productIdentityWords(value: string): Set<string> {
  const spaced = value.replace(/([a-z])([A-Z])/g, "$1 $2");
  return new Set(
    spaced
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !/^[0-9]+$/.test(word))
      .filter(
        (word) => !["the", "and", "for", "size", "unconfirmed"].includes(word),
      ),
  );
}

export function productIdentityOverlap(
  wanted: { name: string; manufacturer: string | null },
  candidate: {
    name: string;
    manufacturer?: string | null;
    model?: string | null;
    aliases?: readonly string[];
    exactIdentifier?: boolean;
  },
) {
  const words = productIdentityWords(
    [candidate.name, candidate.model, ...(candidate.aliases ?? [])]
      .filter(Boolean)
      .join(" "),
  );
  const brand = wanted.manufacturer?.toLowerCase().trim() || null;
  const brandWords = wanted.manufacturer
    ? productIdentityWords(wanted.manufacturer)
    : new Set<string>();
  const shared = [...productIdentityWords(wanted.name)].filter((word) =>
    words.has(word),
  );
  const sharedIdentity = shared.filter((word) => !brandWords.has(word));
  const brandMatch =
    !!brand &&
    (candidate.manufacturer?.toLowerCase() === brand ||
      candidate.name.toLowerCase().includes(brand));
  return {
    shared,
    sharedIdentity,
    brandMatch,
    relevant:
      !!candidate.exactIdentifier ||
      sharedIdentity.length >= (brandMatch ? 1 : 2),
  };
}
