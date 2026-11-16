/** Kinds admitted as transfer anchors and retained transfer legs. */
export function isTransferPairKind(kind: string): boolean {
  return ["account_transfer", "credit_card_payment", "loan_payment"].includes(
    kind,
  );
}
