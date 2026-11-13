/** Reads: SpendingCategory id/shortcode/deletedAt from the requested-key search, including an empty result. Return the original row to preserve snapshot encoding. */
export function spendingCategoryForDiscovery<
  Row extends { id: string; shortcode: string; deletedAt: Date | null },
>(rows: readonly Row[], reference: { id: string } | { shortcode: string }) {
  return rows.find(
    (row) =>
      !row.deletedAt &&
      ("id" in reference
        ? row.id === reference.id
        : row.shortcode === reference.shortcode),
  );
}
/** Reads: the refund original's live Expense id/costMinor/lineKind/future/economicRole and each line's effective category. */
export function refundSpendingCategory(
  lines: readonly {
    id: string;
    costMinor: bigint | null;
    lineKind: string;
    future: boolean;
    economicRole: string;
  }[],
  categories: readonly { id: string; category: string | null }[],
) {
  const eligible = lines.filter(
    (line) => !line.future && line.economicRole === "vendor",
  );
  const negative = eligible.filter(
    (line) =>
      line.costMinor !== null &&
      line.costMinor < 0n &&
      line.lineKind === "principal",
  );
  const chosen = negative.length
    ? negative
    : eligible.filter((line) => line.costMinor !== null && line.costMinor > 0n);
  const ids = new Set(
    chosen.map(
      (line) => categories.find((row) => row.id === line.id)?.category ?? null,
    ),
  );
  const [id] = ids;
  return ids.size === 1 && id ? id : null;
}
/** Reads: live resolved category, current advice confidence/conflict, explicit category-history review, refund provenance and all Vendor category-history results (possibly empty). */
export function bookingSpendingCategory<Row extends { id: string }>(input: {
  category: Row | undefined;
  confidence: string | undefined;
  fromPurchase: boolean;
  historyReviewed: boolean | undefined;
  historyConflict: boolean | undefined;
  history: readonly { category: string | null }[];
}) {
  const category = input.category;
  return category &&
    input.confidence === "high" &&
    (input.fromPurchase ||
      input.historyReviewed ||
      (!input.historyConflict &&
        input.history.every(
          (row) => row.category === null || row.category === category.id,
        )))
    ? category
    : undefined;
}
/** Reads: explicit category choice, selected live category and the same complete Vendor category history. */
export function reviewedCategoryRefusal(input: {
  explicit: boolean;
  categoryId: string | null;
  historyReviewed: boolean | undefined;
  historyConflict: boolean | undefined;
  history: readonly { category: string | null }[];
}) {
  if (!input.explicit) return null;
  if (!input.categoryId)
    return "The reviewed spending category is no longer live.";
  return !input.historyReviewed &&
    (input.historyConflict ||
      input.history.some(
        (row) => row.category !== null && row.category !== input.categoryId,
      ))
    ? "Merchant spending history conflicts with the reviewed category."
    : null;
}
