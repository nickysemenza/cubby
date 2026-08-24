import { z } from "zod";

export interface NormalizedIsbn {
  isbn13: string;
  /** ISBN-10 exists only for the original 978 registration group. */
  isbn10: string | null;
  gtin14: string;
}

const compactIsbn = (value: string): string =>
  value
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "");

const isbn13CheckDigit = (firstTwelve: string): string => {
  const sum = [...firstTwelve].reduce(
    (total, digit, index) =>
      total + Number.parseInt(digit, 10) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return String((10 - (sum % 10)) % 10);
};

const isbn10CheckDigit = (firstNine: string): string => {
  const sum = [...firstNine].reduce(
    (total, digit, index) => total + Number.parseInt(digit, 10) * (10 - index),
    0,
  );
  const remainder = (11 - (sum % 11)) % 11;
  return remainder === 10 ? "X" : String(remainder);
};

const isValidIsbn10 = (value: string): boolean =>
  /^\d{9}[\dX]$/.test(value) &&
  isbn10CheckDigit(value.slice(0, 9)) === value[9];

const isBooklandPrefix = (value: string): boolean =>
  value.startsWith("978") ||
  // 979-0 belongs to ISMN (printed music), not ISBN.
  (value.startsWith("979") && !value.startsWith("9790"));

const isValidIsbn13 = (value: string): boolean =>
  /^\d{13}$/.test(value) &&
  isBooklandPrefix(value) &&
  isbn13CheckDigit(value.slice(0, 12)) === value[12];

const fromIsbn13 = (isbn13: string): NormalizedIsbn => {
  const isbn10 = isbn13.startsWith("978")
    ? `${isbn13.slice(3, 12)}${isbn10CheckDigit(isbn13.slice(3, 12))}`
    : null;
  return { isbn13, isbn10, gtin14: isbn13.padStart(14, "0") };
};

/**
 * Validate either ISBN encoding and return the single identity Cubby stores.
 *
 * ISBN-13 is an EAN/GTIN. ISBN-10 is converted to its ISBN-13 equivalent before
 * storage, so a title cannot acquire two external-id rows merely because two
 * callers used different printed encodings.
 */
export const normalizeIsbn = (value: string): NormalizedIsbn | null => {
  const compact = compactIsbn(value);
  if (/^0\d{13}$/.test(compact) && isValidIsbn13(compact.slice(1))) {
    return fromIsbn13(compact.slice(1));
  }
  if (isValidIsbn10(compact)) {
    const firstTwelve = `978${compact.slice(0, 9)}`;
    return fromIsbn13(`${firstTwelve}${isbn13CheckDigit(firstTwelve)}`);
  }
  return isValidIsbn13(compact) ? fromIsbn13(compact) : null;
};

export const isbnFromGtin = (value: string): NormalizedIsbn | null => {
  if (!/^\d{14}$/.test(value) || value[0] !== "0") return null;
  return normalizeIsbn(value.slice(1));
};

/**
 * Pick the ISBN out of an EPUB's raw OPF `<dc:identifier>` values.
 *
 * A book usually declares several in different schemes, and the OPF's own
 * `unique-identifier` attribute frequently names a Calibre UUID rather than the
 * ISBN — so this scans all of them rather than trusting declaration order.
 * Scheme prefixes (`urn:isbn:`, `ISBN:`) are stripped before validation, and
 * validation is {@link normalizeIsbn}'s: a `urn:uuid:` value has no chance of
 * passing an ISBN check digit, which is what makes scanning everything safe.
 *
 * Returns the canonical GTIN-14, matching how barcodes are stored, or null when
 * the book declares no ISBN at all (common for EPUBs built from web sources).
 */
export const isbnFromEpubIdentifiers = (
  identifiers: readonly string[],
): string | null => {
  for (const raw of identifiers) {
    const stripped = raw.trim().replace(/^(urn:)?isbn:/i, "");
    const normalized = normalizeIsbn(stripped);
    if (normalized) return normalized.gtin14;
  }
  return null;
};

/**
 * Search spellings for a stored book barcode. The canonical GTIN remains first
 * so callers that do not care about books preserve their existing behavior.
 */
export const productCodeSearchTerms = (value: string): string[] => {
  const normalized = isbnFromGtin(value) ?? normalizeIsbn(value);
  if (!normalized) return [value];
  return [
    normalized.gtin14,
    normalized.isbn13,
    ...(normalized.isbn10 ? [normalized.isbn10] : []),
  ];
};

export const isbn = z
  .string()
  .trim()
  .transform((value, ctx) => {
    const normalized = normalizeIsbn(value);
    if (!normalized) {
      ctx.addIssue({
        code: "custom",
        message: "expected a valid ISBN-10 or ISBN-13",
      });
      return z.NEVER;
    }
    return normalized.gtin14;
  });
