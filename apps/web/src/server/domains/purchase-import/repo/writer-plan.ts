import type {
  ExtractedOrderCandidate,
  ExtractedPurchaseLine,
} from "@cubby/schemas/purchase-import";

import type { loadOriginalLineBindings } from "./writer-load";
import {
  decideLineWrite,
  importedLineMatchesExpense,
  originalItemFacts,
  type ExistingExpenseSnapshot,
} from "./writer-policy";

export function planLineMatch(
  candidate: ExtractedOrderCandidate,
  current: ExistingExpenseSnapshot[],
  unpricedForeign: boolean,
  valuation: "USD" | "unknown",
  { sources, bindings }: Awaited<ReturnType<typeof loadOriginalLineBindings>>,
) {
  const originalExpenses = new Map<number, string>();
  for (const source of sources) {
    const prior = source.originalOrder?.extraction.candidate;
    const lines = bindings.filter((row) => row.sourceOrderId === source.id);
    if (
      !prior ||
      JSON.stringify(originalItemFacts(prior)) !==
        JSON.stringify(originalItemFacts(candidate)) ||
      lines.length !== candidate.lines.length ||
      lines.length !== current.length ||
      new Set(lines.map((row) => row.expenseId)).size !== lines.length ||
      lines.some(
        (row) =>
          !row.expenseId || !current.some((item) => item.id === row.expenseId),
      )
    )
      continue;
    for (const line of lines)
      originalExpenses.set(line.lineIndex, line.expenseId!);
    break;
  }
  const matchingExpenses = (line: ExtractedPurchaseLine, lineIndex: number) =>
    current.filter(
      (row) =>
        (!originalExpenses.size ||
          originalExpenses.get(lineIndex) === row.id) &&
        importedLineMatchesExpense(row, line, valuation),
    );
  const decision =
    unpricedForeign && current.length && !originalExpenses.size
      ? { kind: "conflict" as const, reason: "duplicate_lines" as const }
      : decideLineWrite(current, candidate.lines, valuation);
  return { matchingExpenses, decision };
}
