import type { ExpectedMatch } from "./flue-model-eval.fixtures";

/** One proposed group, by fixture photo key; `product` is the fixture key of an existing match. */
export type ScoredProposal = { photos: string[]; product: string | null };

export type ProposalScore = {
  /** Same partition and every match acceptable. */
  exact: boolean;
  /** F1 over photo pairs placed in the same group. */
  pairF1: number;
  /** Share of expected groups whose best-overlapping proposal has an acceptable match. */
  matchAccuracy: number;
  uncovered: string[];
  duplicated: string[];
};

const pairsOf = (groups: readonly (readonly string[])[]) =>
  new Set(
    groups.flatMap((group) => {
      const sorted = [...group].sort();
      return sorted.flatMap((left, index) =>
        sorted.slice(index + 1).map((right) => `${left}|${right}`),
      );
    }),
  );

function acceptable(match: ExpectedMatch, product: string | null) {
  if (match.kind === "create") return product === null;
  if (match.kind === "existing") return product === match.product;
  return product === null || !match.products.includes(product);
}

export function scoreProposals(
  expected: readonly { photos: string[]; match: ExpectedMatch }[],
  photos: readonly string[],
  proposals: readonly ScoredProposal[],
): ProposalScore {
  const counts = new Map<string, number>();
  for (const proposal of proposals)
    for (const photo of proposal.photos)
      counts.set(photo, (counts.get(photo) ?? 0) + 1);
  const uncovered = photos.filter((photo) => !counts.has(photo));
  const duplicated = photos.filter((photo) => (counts.get(photo) ?? 0) > 1);

  const expectedPairs = pairsOf(expected.map((group) => group.photos));
  const proposedPairs = pairsOf(proposals.map((proposal) => proposal.photos));
  const truePairs = [...proposedPairs].filter((pair) =>
    expectedPairs.has(pair),
  ).length;
  // Singleton-only answers have no pairs; agreeing on "no pairs" is perfect.
  const precision = proposedPairs.size ? truePairs / proposedPairs.size : 1;
  const recall = expectedPairs.size ? truePairs / expectedPairs.size : 1;
  const pairF1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  const matched = expected.filter((group) => {
    const best = proposals
      .map((proposal) => ({
        proposal,
        overlap: proposal.photos.filter((photo) => group.photos.includes(photo))
          .length,
      }))
      .sort((left, right) => right.overlap - left.overlap)[0];
    return (
      best !== undefined &&
      best.overlap > 0 &&
      acceptable(group.match, best.proposal.product)
    );
  }).length;
  const matchAccuracy = expected.length ? matched / expected.length : 1;

  const partitionKey = (groups: readonly (readonly string[])[]) =>
    groups
      .map((group) => [...group].sort().join(","))
      .sort()
      .join(";");
  const exact =
    uncovered.length === 0 &&
    duplicated.length === 0 &&
    partitionKey(expected.map((group) => group.photos)) ===
      partitionKey(proposals.map((proposal) => proposal.photos)) &&
    matchAccuracy === 1;

  return { exact, pairF1, matchAccuracy, uncovered, duplicated };
}
