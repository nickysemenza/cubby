import {
  type ExpenseLineKind,
  inspectExpenseLineKind,
} from "@cubby/schemas/expense-line-kind";

export type ExpenseLineKindBackfillRow = {
  id: string;
  shortcode: string;
  name: string;
  lineKind: ExpenseLineKind;
  productId: string | null;
  deletedAt: Date | string | null;
};

type ExpenseLineKindBackfillCandidate = Pick<
  ExpenseLineKindBackfillRow,
  "id" | "shortcode" | "name"
> & {
  from: "principal";
  to: Exclude<ExpenseLineKind, "principal">;
};

/**
 * Pure, deterministic planning pass shared by the one-shot script and tests.
 * The database write repeats every eligibility predicate, so this plan is an
 * explanation of the intended mutations rather than a stale authorization.
 */
export function planExpenseLineKindBackfill(
  rows: readonly ExpenseLineKindBackfillRow[],
) {
  const candidates: ExpenseLineKindBackfillCandidate[] = [];
  const ambiguous: Array<
    Pick<ExpenseLineKindBackfillRow, "shortcode" | "name"> & {
      hintedKinds: string[];
    }
  > = [];
  const unchanged: Array<
    Pick<ExpenseLineKindBackfillRow, "shortcode" | "name">
  > = [];
  const skipped: Array<
    Pick<ExpenseLineKindBackfillRow, "shortcode" | "name"> & {
      reason: "deleted" | "already_classified" | "product_linked";
    }
  > = [];

  for (const row of [...rows].sort((a, b) =>
    a.shortcode.localeCompare(b.shortcode),
  )) {
    if (row.deletedAt !== null) {
      skipped.push({
        shortcode: row.shortcode,
        name: row.name,
        reason: "deleted",
      });
      continue;
    }
    if (row.lineKind !== "principal") {
      skipped.push({
        shortcode: row.shortcode,
        name: row.name,
        reason: "already_classified",
      });
      continue;
    }
    if (row.productId !== null) {
      skipped.push({
        shortcode: row.shortcode,
        name: row.name,
        reason: "product_linked",
      });
      continue;
    }

    const inspection = inspectExpenseLineKind({ name: row.name });
    if (
      inspection.confidence === "high" &&
      inspection.lineKind !== "principal"
    ) {
      candidates.push({
        id: row.id,
        shortcode: row.shortcode,
        name: row.name,
        from: "principal",
        to: inspection.lineKind,
      });
    } else if (inspection.confidence === "ambiguous") {
      ambiguous.push({
        shortcode: row.shortcode,
        name: row.name,
        hintedKinds: inspection.hintedKinds,
      });
    } else {
      unchanged.push({ shortcode: row.shortcode, name: row.name });
    }
  }

  return { candidates, ambiguous, unchanged, skipped };
}
