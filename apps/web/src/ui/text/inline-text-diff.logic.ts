type DiffSeg = { type: "common" | "add" | "remove"; text: string };

// Tokenize into word and non-word (punctuation/space) runs so " , fresh" diffs as
// whole tokens rather than character noise.
const tokenize = (s: string): string[] => s.match(/\w+|\W+/g) ?? [];

/**
 * Word-level LCS diff, bounded for long notes and applied activity history.
 * Returns ordered segments: shared text plus the runs added/removed to get from a→b.
 */
export const diffWords = (before: string, after: string): DiffSeg[] => {
  if (before === after) return before ? [{ type: "common", text: before }] : [];
  const a = tokenize(before);
  const b = tokenize(after);
  const n = a.length;
  const m = b.length;
  // A large replacement remains inspectable without allocating a quadratic table.
  if (n * m > 250_000)
    return [
      ...(before ? [{ type: "remove" as const, text: before }] : []),
      ...(after ? [{ type: "add" as const, text: after }] : []),
    ];
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from<number>({ length: m + 1 }).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  // Walk the table, coalescing consecutive same-type tokens into one segment.
  const segs: DiffSeg[] = [];
  const push = (type: DiffSeg["type"], text: string) => {
    const last = segs[segs.length - 1];
    if (last && last.type === type) last.text += text;
    else segs.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("common", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("remove", a[i++]!);
    } else {
      push("add", b[j++]!);
    }
  }
  while (i < n) push("remove", a[i++]!);
  while (j < m) push("add", b[j++]!);
  return segs;
};
