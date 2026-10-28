export type ReadPolicy = "context" | "strong";

/** Entry, reconciliation and inventory decisions must use current evidence. */
const strongReadOperations = new Set([
  "expense.chargeContext",
  "expense.inventoryOwnershipContext",
  "expense.vendorAttributionDefaults",
  "householdContribution.ledger",
  "inventory.receivingContext",
  "purchase.settlementCandidates",
  "purchase.checkLinkExpenses",
  "purchase.checkSettlementAllocation",
  "purchase.checkSplit",
  "purchase.linkExpenseCandidates",
  "purchase.splitStart",
]);

/** Ordinary display reads use the member's bounded-stale policy. */
export function readPolicyFor(
  operation: string,
  kind: "query" | "mutation",
  entity?: string,
  reportSlots: readonly string[] = [],
): ReadPolicy {
  if (
    kind === "mutation" ||
    strongReadOperations.has(operation) ||
    (operation.startsWith("entityReport.") &&
      reportSlots.some((slot) =>
        [
          "expense.",
          "purchase.",
          "financialTransaction.",
          "financialAccount.",
          "ledgerTransfer.",
        ].some((prefix) => slot.startsWith(prefix)),
      )) ||
    operation.startsWith("financialTransaction.") ||
    operation.startsWith("transactionImport.") ||
    operation.startsWith("sourceTransactionRecord.") ||
    ((operation.startsWith("entity.") ||
      operation.startsWith("entityReport.")) &&
      entity !== undefined &&
      [
        "expense",
        "purchase",
        "financialAccount",
        "financialTransaction",
        "sourceTransactionRecord",
        "transactionImport",
        "ledgerTransfer",
      ].includes(entity))
  )
    return "strong";
  return "context";
}

/** This maintenance request changes only its strong-read cooldown claim. */
export function mutationChangesHouseholdData(operation: string): boolean {
  return operation !== "maintenance.requestCatchUp";
}
