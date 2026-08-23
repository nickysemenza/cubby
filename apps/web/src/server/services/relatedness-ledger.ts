import type { RelatednessOut } from "@cubby/schemas/relatedness";

type SemanticCandidate = {
  id: string;
  title: string;
  similarity: number;
};

type TagCandidate = {
  shortcode: string;
  name: string;
  tags: string[];
};

type ProductRelatednessSignalPresentation = {
  semantic: { label: string; weight: number };
  tag: { label: string };
};

const defaultPresentation: ProductRelatednessSignalPresentation = {
  semantic: { label: "Similar meaning", weight: 1 },
  tag: { label: "Shared tag" },
};

/**
 * One display ledger joins scored candidates with display-only evidence before
 * the wire boundary, preventing the semantic rail and tag rail from drifting.
 */
export function buildProductRelatednessLedger(
  semantic: readonly SemanticCandidate[],
  siblings: readonly TagCandidate[],
  isVisible: (shortcode: string) => boolean,
  presentation: ProductRelatednessSignalPresentation = defaultPresentation,
): RelatednessOut["items"] {
  const ledger = new Map<string, RelatednessOut["items"][number]>();
  for (const candidate of semantic) {
    if (!isVisible(candidate.id)) continue;
    ledger.set(candidate.id, {
      entity: "product",
      shortcode: candidate.id,
      title: candidate.title,
      score: candidate.similarity,
      evidence: [
        {
          signal: presentation.semantic.label,
          detail: null,
          weight: candidate.similarity * presentation.semantic.weight,
        },
      ],
    });
  }
  for (const sibling of siblings) {
    if (!isVisible(sibling.shortcode)) continue;
    const tagEvidence = {
      signal: presentation.tag.label,
      detail: sibling.tags.join(", "),
      weight: 0,
    };
    const existing = ledger.get(sibling.shortcode);
    if (existing) existing.evidence.push(tagEvidence);
    else {
      ledger.set(sibling.shortcode, {
        entity: "product",
        shortcode: sibling.shortcode,
        title: sibling.name,
        score: 0,
        evidence: [tagEvidence],
      });
    }
  }
  return [...ledger.values()].sort((a, b) => b.score - a.score);
}
