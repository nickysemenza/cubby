interface ClassificationCandidate {
  name: string;
  aliases?: readonly string[];
  description?: string | null;
  path: readonly { name: string }[];
}

/** Prioritize relevant lexical evidence without discarding broad choices. */
export function rankCategoryCandidates<C extends ClassificationCandidate>(
  candidates: readonly C[],
  basis: Readonly<Record<string, string | null>>,
): C[] {
  const words = new Set(
    Object.values(basis)
      .join(" ")
      .toLowerCase()
      .match(/[\p{L}\p{N}]{3,}/gu) ?? [],
  );
  const score = (candidate: C) => {
    const primary = [candidate.name, ...(candidate.aliases ?? [])]
      .join(" ")
      .toLowerCase();
    const context = [
      candidate.description,
      ...candidate.path.map((node) => node.name),
    ]
      .join(" ")
      .toLowerCase();
    return [...words].reduce(
      (total, word) =>
        total +
        (primary.includes(word) ? 3 : 0) +
        (context.includes(word) ? 1 : 0),
      0,
    );
  };
  return candidates
    .map((candidate, index) => ({ candidate, index, score: score(candidate) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ candidate }) => candidate);
}
