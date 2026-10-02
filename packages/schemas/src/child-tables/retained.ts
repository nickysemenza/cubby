/** Shrink-only exceptions to declared child storage; each table has a shared or infrastructure owner. */
export const retainedTableReasons = {
  upcLookupCache: "Vendor-neutral provider cache, not owned by one Product.",
  entityEmbedding: "Shared search infrastructure across entity kinds.",
  searchDocument: "Shared lexical projection across entity kinds.",
  suggestionDismissal: "Shared suggestion state across entity kinds.",
  productMatchCandidate: "Pair-grain Product recommendation state.",
  dataExceptionRecord: "Shared evidence exceptions across entity kinds.",
  entityAttachment: "Shared typed attachments across entity kinds.",
  entityLink: "Shared typed relation edges across entity kinds.",
  externalSource: "Shared outside-system identity registry.",
  entityExternalId: "Shared outside identifiers across entity kinds.",
  ledgerSourceClaim: "Dual-owned Expense / LedgerTransfer source evidence.",
  aiAnalysis: "Shared model analysis cache across entity kinds.",
  aiUsage: "Shared model usage telemetry.",
  mcpToolCall: "Shared MCP transport telemetry.",
  auditLog: "Shared audit history across entity kinds.",
  appSettings: "Global application settings.",
} as const;

export const retainedTableExports = Object.keys(retainedTableReasons);
