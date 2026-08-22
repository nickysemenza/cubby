import { describe, expect, it } from "vitest";
import {
  isbn,
  isbnFromEpubIdentifiers,
  isbnFromGtin,
  normalizeIsbn,
  productCodeSearchTerms,
} from "./isbn";

describe("ISBN identity", () => {
  it("normalizes ISBN-10 and ISBN-13 to one GTIN-14", () => {
    const fromTen = normalizeIsbn("0-306-40615-2");
    const fromThirteen = normalizeIsbn("978-0-306-40615-7");

    expect(fromTen).toEqual({
      isbn10: "0306406152",
      isbn13: "9780306406157",
      gtin14: "09780306406157",
    });
    expect(fromThirteen).toEqual(fromTen);
    expect(isbn.parse("0-306-40615-2")).toBe("09780306406157");
    expect(isbn.parse(isbn.parse("0-306-40615-2"))).toBe("09780306406157");
  });

  it("derives ISBN search aliases from a stored GTIN", () => {
    expect(isbnFromGtin("09780306406157")?.isbn13).toBe("9780306406157");
    expect(productCodeSearchTerms("09780306406157")).toEqual([
      "09780306406157",
      "9780306406157",
      "0306406152",
    ]);
  });

  it("accepts 979 ISBNs without inventing an ISBN-10", () => {
    expect(normalizeIsbn("979-10-90636-07-1")).toEqual({
      isbn10: null,
      isbn13: "9791090636071",
      gtin14: "09791090636071",
    });
  });

  it("rejects bad checksums and the 979-0 ISMN namespace", () => {
    expect(normalizeIsbn("0-306-40615-3")).toBeNull();
    expect(normalizeIsbn("9780306406158")).toBeNull();
    expect(normalizeIsbn("979-0-060-11561-5")).toBeNull();
    expect(isbn.safeParse("B07NJSDBQ3").success).toBe(false);
  });

  it("does not reinterpret an arbitrary barcode as an ISBN", () => {
    expect(productCodeSearchTerms("00012345678905")).toEqual([
      "00012345678905",
    ]);
  });
});

describe("isbnFromEpubIdentifiers", () => {
  // A Calibre-produced EPUB declares the UUID first and names IT as the OPF's
  // `unique-identifier`, so trusting declaration order or that attribute would
  // pick the wrong value on the most common kind of book in the library.
  it("finds the ISBN behind a leading Calibre UUID", () => {
    expect(
      isbnFromEpubIdentifiers([
        "urn:uuid:6f2b1a30-1f1e-4f6a-9d5a-000000000000",
        "urn:isbn:9781579656317",
      ]),
    ).toBe("09781579656317");
  });

  it("strips either scheme prefix, and accepts a bare ISBN", () => {
    expect(isbnFromEpubIdentifiers(["ISBN:978-1-57965-631-7"])).toBe(
      "09781579656317",
    );
    expect(isbnFromEpubIdentifiers(["9781579656317"])).toBe("09781579656317");
  });

  // ISBN-10 normalizes to the same identity, so a book can't acquire a second
  // Product merely because its EPUB printed the older encoding.
  it("normalizes an ISBN-10 to the same GTIN-14 as its ISBN-13", () => {
    expect(isbnFromEpubIdentifiers(["0306406152"])).toBe("09780306406157");
  });

  // The reason scanning every identifier is safe: nothing that isn't an ISBN
  // can pass the check digit, so a UUID-only book yields null rather than a
  // wrong match that would link the cookbook to some unrelated product.
  it("returns null when no identifier is a valid ISBN", () => {
    expect(
      isbnFromEpubIdentifiers([
        "urn:uuid:6f2b1a30-1f1e-4f6a-9d5a-000000000000",
        "calibre:1234",
        "9780306406158",
      ]),
    ).toBeNull();
    expect(isbnFromEpubIdentifiers([])).toBeNull();
  });
});
