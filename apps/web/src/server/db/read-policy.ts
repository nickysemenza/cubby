export type ReadPolicy = "context" | "strong";

/** Generic entity reads and report slots over these entities are money evidence. */
const financialEntities = new Set([
  "expense",
  "purchase",
  "financialAccount",
  "financialTransaction",
  "sourceTransactionRecord",
  "transactionImport",
  "ledgerTransfer",
]);

/**
 * The read policy of a query whose contract declares none: a generic entity
 * read or report over a financial entity stays strong so an operation's
 * context policy cannot downgrade money.
 */
export function inputReadPolicy(
  entity: string | undefined,
  reportSlots: readonly string[],
): ReadPolicy {
  if (entity !== undefined && financialEntities.has(entity)) return "strong";
  if (reportSlots.some((slot) => financialEntities.has(slot.split(".")[0]!)))
    return "strong";
  return "context";
}
