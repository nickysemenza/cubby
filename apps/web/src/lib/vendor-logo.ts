/**
 * Return a row's persisted vendor id only while its rendered name still matches.
 * Inline edits optimistically update the name before the server row refetches;
 * withholding the stale id avoids showing and linking the previous vendor.
 */
export function persistedVendorId<
  T extends { vendor: string | null; vendorId: string | null },
>(displayedName: string, row: T): string | null {
  return displayedName === row.vendor ? row.vendorId : null;
}
