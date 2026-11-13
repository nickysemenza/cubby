import { cents } from "@cubby/shared";

import { liveHouseholdLoan } from "~/server/domains/financial-account/repo/purchaser";

export type StatementMovementClass =
  | "standard"
  | "loan_payment"
  | "escrow_interest"
  | "escrow_refund"
  | "escrow_disbursement"
  | "loan_unknown";

export type StatementEffectiveMovement = {
  effectiveAmount: number;
  movementClass: StatementMovementClass;
  reviewReason: string | null;
};

export type StatementMovementInput = {
  providerAmount: number;
  description: string | null;
  merchant: string | null;
  sourceCategory: string | null;
  loan: { providerVendorNames: readonly string[] } | null;
};

const normalize = (value: string) =>
  value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export type StatementLoanAccount = NonNullable<
  Parameters<typeof liveHouseholdLoan>[0]
> & {
  sourceAliases: {
    source: string;
    alias: string;
    externalAccountId: string | null;
  }[];
  vendorName: string | null;
  vendorAliases: string[] | null;
};

/** Require the resolved account and a unique source/account alias to agree. */
export function statementLoanInput(
  row: { source: string; account: string; providerAccountId?: string | null },
  account: StatementLoanAccount | null | undefined,
  accounts: readonly StatementLoanAccount[],
  observations: readonly { providerAccountId: string | null }[],
): StatementMovementInput["loan"] {
  if (!account || !liveHouseholdLoan(account)) return null;
  if (
    row.providerAccountId &&
    observations.some(
      (observation) =>
        observation.providerAccountId !== null &&
        observation.providerAccountId !== row.providerAccountId,
    )
  )
    return null;
  const scoped = row.providerAccountId
    ? accounts.filter((candidate) =>
        candidate.sourceAliases.some(
          (alias) =>
            alias.source === row.source &&
            alias.externalAccountId === row.providerAccountId,
        ),
      )
    : [];
  if (
    !scoped.length &&
    row.providerAccountId &&
    accounts.some((candidate) =>
      candidate.sourceAliases.some(
        (alias) =>
          alias.source === row.source &&
          normalize(alias.alias) === normalize(row.account) &&
          alias.externalAccountId !== null &&
          alias.externalAccountId !== row.providerAccountId,
      ),
    )
  )
    return null;
  const matches = scoped.length
    ? scoped
    : accounts.filter((candidate) =>
        candidate.sourceAliases.some(
          (alias) =>
            alias.source === row.source &&
            normalize(alias.alias) === normalize(row.account) &&
            (!row.providerAccountId ||
              !alias.externalAccountId ||
              alias.externalAccountId === row.providerAccountId),
        ),
      );
  if (matches.length !== 1 || matches[0]!.id !== account.id) return null;
  return {
    providerVendorNames: [
      account.vendorName,
      ...(account.vendorAliases ?? []),
    ].filter((name): name is string => Boolean(name)),
  };
}

export function statementEffectiveMovement(
  input: StatementMovementInput,
): StatementEffectiveMovement {
  if (!input.loan)
    return {
      effectiveAmount: -input.providerAmount,
      movementClass: "standard",
      reviewReason: null,
    };
  const text = normalize(input.description ?? input.merchant ?? "");
  const interest =
    text === "interest on esc" || /\bescrow interest\b/.test(text);
  const refund = text === "escrow refund";
  const disbursement =
    /\b(property tax|county tax|tax disbursement|homeowners insurance(?: disbursement)?)\b/.test(
      text,
    );
  const payment =
    [
      "payment",
      "loan payment",
      "mortgage payment",
      "payment received",
      "automatic payment",
    ].includes(text) ||
    (text !== "" &&
      input.loan.providerVendorNames.some((name) => normalize(name) === text) &&
      !/\b(refund|interest|disbursement)\b/.test(text));
  // Recognize contradictory class words even when the phrase is not itself an exact class.
  const signals = [
    interest || /\binterest\b/.test(text),
    refund || /\brefund\b/.test(text),
    payment || /\bpayment\b/.test(text),
    disbursement,
  ];
  const contradictory =
    signals.filter(Boolean).length > 1 || cents(input.providerAmount) === 0;
  const movementClass: StatementMovementClass = contradictory
    ? "loan_unknown"
    : interest
      ? "escrow_interest"
      : refund
        ? "escrow_refund"
        : payment
          ? "loan_payment"
          : disbursement
            ? "escrow_disbursement"
            : "loan_unknown";
  const magnitude = Math.abs(cents(input.providerAmount)) / 100;
  return {
    effectiveAmount:
      movementClass === "loan_unknown"
        ? -input.providerAmount
        : movementClass === "escrow_disbursement"
          ? magnitude
          : -magnitude,
    movementClass,
    reviewReason:
      movementClass === "loan_unknown"
        ? "Loan movement requires review."
        : null,
  };
}
