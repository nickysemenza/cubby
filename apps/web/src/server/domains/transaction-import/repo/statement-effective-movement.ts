/**
 * The one signed amount every statement consumer reads. Provider evidence keeps
 * its raw amount; matching, kind, spending and correction use this projection.
 */
export type StatementMovementClass =
  | "standard"
  | "loan_payment"
  | "escrow_interest"
  | "escrow_refund"
  | "escrow_disbursement"
  | "loan_unknown";

export type StatementEffectiveMovement = {
  /** Dollars, in the same sign convention as today's `-providerAmount` projection. */
  effectiveAmount: number;
  movementClass: StatementMovementClass;
  /** Set for `loan_unknown`; the row stays in member review. */
  reviewReason: string | null;
};

export type StatementMovementInput = {
  providerAmount: number;
  description: string | null;
  merchant: string | null;
  sourceCategory: string | null;
  /** Non-null only when the row's source/account binds uniquely to a live household loan. */
  loan: { providerVendorNames: readonly string[] } | null;
};

export function statementEffectiveMovement(
  input: StatementMovementInput,
): StatementEffectiveMovement {
  return {
    effectiveAmount: -input.providerAmount,
    movementClass: "standard",
    reviewReason: null,
  };
}
