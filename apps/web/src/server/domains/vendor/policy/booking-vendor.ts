type VendorRead = { id: string; shortcode: string; created?: boolean };
type ResolutionRead = {
  row: VendorRead | null | undefined;
  candidates: readonly VendorRead[];
};
export type BookingVendorRead = {
  vendorId: string | null;
  selectedCode: string | undefined;
  name: string;
  merchant: string | undefined;
};
/** Reads: resolved Vendor name/alias candidate rows for every raw/clean name, including misses, plus each reviewed Vendor choice. */
export function bookingVendorCreations(
  bookings: readonly BookingVendorRead[],
  checked: readonly (readonly ResolutionRead[])[],
) {
  for (const [index, booking] of bookings.entries())
    if (
      !booking.selectedCode &&
      checked[index]!.some(
        (result) =>
          (result.row && result.row.shortcode !== booking.vendorId) ||
          result.candidates.some((row) => row.shortcode !== booking.vendorId),
      )
    )
      return {
        kind: "refused" as const,
        reason: "The raw or cleaned Vendor identity changed before booking.",
      };
  const creating = bookings.flatMap((booking, index) =>
    !booking.selectedCode && !booking.vendorId ? [index] : [],
  );
  const folded = creating.map((index) =>
    bookings[index]!.name.trim().toLowerCase(),
  );
  if (new Set(folded).size !== folded.length)
    return {
      kind: "refused" as const,
      reason:
        "Spending plans in one batch create the same Vendor; apply them separately.",
    };
  return {
    kind: "ready" as const,
    creating,
    misses: creating.map((index) => {
      const booking = bookings[index]!;
      return {
        name: booking.name,
        aliases:
          booking.merchant && booking.merchant !== booking.name
            ? [booking.merchant]
            : [],
      };
    }),
  };
}
/** Reads: live explicitly selected Vendors, all name-resolution results, and results of the declared Vendor creations. */
export function bookingVendorSelection(
  bookings: readonly BookingVendorRead[],
  checked: readonly (readonly ResolutionRead[])[],
  selected: readonly VendorRead[],
  created: ReadonlyMap<number, ResolutionRead | undefined>,
) {
  const rows: VendorRead[] = [];
  for (const [index, booking] of bookings.entries()) {
    const chosen = booking.selectedCode
      ? selected.find((row) => row.shortcode === booking.selectedCode)
      : undefined;
    const resolved = chosen
      ? { row: chosen, candidates: [] }
      : booking.vendorId
        ? checked[index]!.find(
            (result) => result.row?.shortcode === booking.vendorId,
          )
        : created.get(index);
    if (!resolved?.row || resolved.candidates.length)
      return {
        kind: "refused" as const,
        reason: "The Vendor identity changed before booking.",
      };
    rows.push(resolved.row);
  }
  return { kind: "ready" as const, rows };
}
/** Reads: re-resolved raw/clean names after creation, every newly minted Vendor shortcode and the selected shortcode per booking. */
export function createdVendorConflict(
  rechecked: readonly (readonly ResolutionRead[])[],
  minted: ReadonlySet<string>,
  codes: readonly string[],
) {
  return rechecked.some((results, index) =>
    results.some((result) =>
      [result.row, ...result.candidates].some(
        (row) =>
          row && minted.has(row.shortcode) && row.shortcode !== codes[index],
      ),
    ),
  );
}
