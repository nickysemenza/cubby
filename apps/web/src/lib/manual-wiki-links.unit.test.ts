import { describe, expect, it } from "vitest";
import { pageFromManualHref, resolveWikiLinks } from "./manual-wiki-links";

const DOCS = [
  {
    id: "doc-1",
    filename: "BES840-instruction-manual.pdf",
    url: "https://r2.example/documents/P-EU8Y/BES840-instruction-manual.pdf",
  },
  {
    id: "doc-2",
    filename: "warranty-card.pdf",
    url: "https://r2.example/documents/P-EU8Y/warranty-card.pdf",
  },
];

describe("resolveWikiLinks", () => {
  it("rewrites an exact-filename link with a page", () => {
    expect(
      resolveWikiLinks("see [[BES840-instruction-manual.pdf#page=63]]", DOCS),
    ).toBe(
      "see [BES840-instruction-manual · p.63](https://r2.example/documents/P-EU8Y/BES840-instruction-manual.pdf#page=63)",
    );
  });

  it("matches without the .pdf extension and case-insensitively", () => {
    expect(
      resolveWikiLinks("[[bes840-instruction-manual#page=5]]", DOCS),
    ).toContain("#page=5");
  });

  it("resolves unambiguous substring matches", () => {
    expect(resolveWikiLinks("[[warranty#page=2]]", DOCS)).toContain(
      "warranty-card.pdf#page=2",
    );
  });

  it("uses the first manual for the [[#page=N]] shorthand", () => {
    expect(resolveWikiLinks("[[#page=12]]", DOCS)).toContain(
      "BES840-instruction-manual.pdf#page=12",
    );
  });

  it("escapes backslashes in labels so they can't eat the closing bracket", () => {
    expect(resolveWikiLinks("[[warranty#page=2|trailing\\]]", DOCS)).toBe(
      "[trailing\\\\](https://r2.example/documents/P-EU8Y/warranty-card.pdf#page=2)",
    );
  });

  it("honors a custom label", () => {
    expect(resolveWikiLinks("[[warranty#page=2|the fine print]]", DOCS)).toBe(
      "[the fine print](https://r2.example/documents/P-EU8Y/warranty-card.pdf#page=2)",
    );
  });

  it("links the whole document when no page fragment is given", () => {
    expect(resolveWikiLinks("[[warranty-card]]", DOCS)).toBe(
      "[warranty-card](https://r2.example/documents/P-EU8Y/warranty-card.pdf)",
    );
  });

  it("leaves unresolved and ambiguous targets as literal text", () => {
    expect(resolveWikiLinks("[[missing.pdf#page=3]]", DOCS)).toBe(
      "[[missing.pdf#page=3]]",
    );
    // "a" appears in both filenames — ambiguous substring stays literal.
    expect(resolveWikiLinks("[[a#page=3]]", DOCS)).toBe("[[a#page=3]]");
  });

  it("leaves non-page fragments and empty doc lists untouched", () => {
    expect(resolveWikiLinks("[[warranty#section=2]]", DOCS)).toBe(
      "[[warranty#section=2]]",
    );
    expect(resolveWikiLinks("[[warranty#page=2]]", [])).toBe(
      "[[warranty#page=2]]",
    );
  });
});

describe("pageFromManualHref", () => {
  it("extracts the page and defaults to 1", () => {
    expect(pageFromManualHref("https://x/doc.pdf#page=63")).toBe(63);
    expect(pageFromManualHref("https://x/doc.pdf")).toBe(1);
  });
});
