/**
 * Obsidian-style wiki links for product notes, resolved against the product's
 * attached PDF manuals:
 *
 *   [[BES840-instruction-manual.pdf#page=63]]   → named manual, page 63
 *   [[BES840#page=63]]                          → fuzzy filename match
 *   [[#page=63]]                                → first manual
 *   [[manual.pdf#page=5|descaling steps]]       → custom label
 *
 * Pure string logic, alias-free so the node "unit" vitest project can import
 * it directly; the rendering half lives in product-notes-markdown.tsx.
 */

export interface ManualDocument {
  id: string;
  filename: string;
  url: string;
}

const WIKI_LINK = /\[\[([^[\]]+)\]\]/g;

const stripPdfExt = (filename: string) => filename.replace(/\.pdf$/i, "");

function resolveManualDocument<T extends ManualDocument>(
  name: string,
  documents: T[],
): T | undefined {
  if (name === "") return documents[0];
  const lower = name.toLowerCase();
  const exact = documents.find(
    (d) =>
      d.filename.toLowerCase() === lower ||
      stripPdfExt(d.filename).toLowerCase() === lower,
  );
  if (exact) return exact;
  // Substring fallback — only when unambiguous.
  const partial = documents.filter((d) =>
    d.filename.toLowerCase().includes(lower),
  );
  return partial.length === 1 ? partial[0] : undefined;
}

// Escape characters that would terminate the markdown link label early.
const escapeLabel = (label: string) => label.replace(/([[\]])/g, "\\$1");

/** Rewrite [[...]] wiki links to standard markdown links at the PDF URL. */
export function resolveWikiLinks(
  notes: string,
  documents: ManualDocument[],
): string {
  if (documents.length === 0) return notes;
  return notes.replace(WIKI_LINK, (original, inner: string) => {
    const [targetRaw = "", labelRaw] = inner.split("|");
    const target = targetRaw.trim();
    const hashIndex = target.indexOf("#");
    const name = (
      hashIndex === -1 ? target : target.slice(0, hashIndex)
    ).trim();
    const fragment = hashIndex === -1 ? "" : target.slice(hashIndex + 1).trim();

    const pageMatch = /^page=(\d+)$/i.exec(fragment);
    if (fragment !== "" && !pageMatch) return original;

    const doc = resolveManualDocument(name, documents);
    if (!doc) return original;

    const page = pageMatch?.[1] ? Number(pageMatch[1]) : null;
    const label =
      labelRaw?.trim() ||
      (page !== null
        ? `${stripPdfExt(doc.filename)} · p.${page}`
        : stripPdfExt(doc.filename));
    const href = page !== null ? `${doc.url}#page=${page}` : doc.url;
    return `[${escapeLabel(label)}](${href})`;
  });
}

/** Page number from a rewritten manual href (defaults to 1). */
export function pageFromManualHref(href: string): number {
  const match = /#page=(\d+)$/.exec(href);
  return match?.[1] ? Number(match[1]) : 1;
}
