export const resolveBeneficiaryEvidence = <PartyId extends string>(args: {
  applicableExpenseIds: readonly string[];
  rows: readonly {
    expenseShortcode: string;
    ledgerPartyId: PartyId | null;
  }[];
  isIndividual: (id: PartyId) => boolean;
}):
  | {
      status: "none";
      ownerId: null;
      reason: "beneficiary_absent" | "beneficiary_unknown";
    }
  | {
      status: "blocked";
      ownerId: null;
      reason:
        | "beneficiary_incomplete"
        | "beneficiary_split"
        | "beneficiary_unresolved"
        | "beneficiary_not_individual"
        | "beneficiary_conflict";
    }
  | { status: "owner"; ownerId: PartyId; reason: "beneficiary_agreement" } => {
  if (args.rows.length === 0)
    return { status: "none", ownerId: null, reason: "beneficiary_absent" };
  // Entirely unknown shares are financial attribution, not an ownership decision.
  // A partially named acquisition still blocks weaker account defaults.
  if (args.rows.every((row) => row.ledgerPartyId === null))
    return { status: "none", ownerId: null, reason: "beneficiary_unknown" };
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
  const reason = args.applicableExpenseIds.some((id) => !rowsByExpense.has(id))
    ? "beneficiary_incomplete"
    : args.applicableExpenseIds.some(
          (id) => (rowsByExpense.get(id)?.length ?? 0) > 1,
        )
      ? "beneficiary_split"
      : args.rows.some((row) => row.ledgerPartyId === null)
        ? "beneficiary_unresolved"
        : owners.some((id) => id === null)
          ? "beneficiary_not_individual"
          : "beneficiary_conflict";
  return owners.some((id) => id === null) || distinct.size !== 1
    ? { status: "blocked", ownerId: null, reason }
    : {
        status: "owner",
        ownerId: [...distinct][0]!,
        reason: "beneficiary_agreement",
      };
};

type PaymentEvidenceResolution<PartyId extends string> = {
  ownerId: PartyId | null;
  reason:
    | "payment_absent"
    | "payment_disabled"
    | "payment_unresolved"
    | "payment_not_individual"
    | "payment_conflict"
    | "payment_agreement";
};

export const resolvePaymentEvidence = <PartyId extends string>(args: {
  rows: readonly { enabled: boolean; ledgerPartyId: PartyId | null }[];
  isIndividual: (id: PartyId) => boolean;
}): PaymentEvidenceResolution<PartyId> => {
  if (args.rows.length === 0)
    return { ownerId: null, reason: "payment_absent" };
  const owners = args.rows.map((row) =>
    row.enabled && row.ledgerPartyId && args.isIndividual(row.ledgerPartyId)
      ? row.ledgerPartyId
      : null,
  );
  const distinct = new Set(owners.filter((id) => id !== null));
  const reason = args.rows.some((row) => !row.enabled)
    ? "payment_disabled"
    : args.rows.some((row) => row.ledgerPartyId === null)
      ? "payment_unresolved"
      : owners.some((id) => id === null)
        ? "payment_not_individual"
        : "payment_conflict";
  return owners.every((id) => id !== null) && distinct.size === 1
    ? { ownerId: [...distinct][0]!, reason: "payment_agreement" }
    : { ownerId: null, reason };
};
