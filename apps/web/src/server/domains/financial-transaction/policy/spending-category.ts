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
