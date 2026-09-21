export const resolveBeneficiaryEvidence = <PartyId extends string>(args: {
  applicableExpenseIds: readonly string[];
  rows: readonly {
    expenseShortcode: string;
    ledgerPartyId: PartyId | null;
  }[];
  isIndividual: (id: PartyId) => boolean;
}):
  | { status: "none" | "blocked"; ownerId: null }
  | { status: "owner"; ownerId: PartyId } => {
  if (args.rows.length === 0) return { status: "none", ownerId: null };
  const rowsByExpense = new Map<string, typeof args.rows>();
  for (const row of args.rows) {
    rowsByExpense.set(row.expenseShortcode, [
      ...(rowsByExpense.get(row.expenseShortcode) ?? []),
      row,
    ]);
  }
  const owners = args.applicableExpenseIds.map((id) => {
    const rows = rowsByExpense.get(id) ?? [];
    if (rows.length !== 1) return null;
    const ownerId = rows[0]!.ledgerPartyId;
    return ownerId && args.isIndividual(ownerId) ? ownerId : null;
  });
  const distinct = new Set(owners.filter((id) => id !== null));
  return owners.some((id) => id === null) || distinct.size !== 1
    ? { status: "blocked", ownerId: null }
    : { status: "owner", ownerId: [...distinct][0]! };
};

export const resolvePaymentEvidence = <PartyId extends string>(args: {
  rows: readonly { enabled: boolean; ledgerPartyId: PartyId | null }[];
  isIndividual: (id: PartyId) => boolean;
}): PartyId | null => {
  if (args.rows.length === 0) return null;
  const owners = args.rows.map((row) =>
    row.enabled && row.ledgerPartyId && args.isIndividual(row.ledgerPartyId)
      ? row.ledgerPartyId
      : null,
  );
  const distinct = new Set(owners.filter((id) => id !== null));
  return owners.every((id) => id !== null) && distinct.size === 1
    ? [...distinct][0]!
    : null;
};
