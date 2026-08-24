import {
  financialAccountCreateInput,
  financialAccountFilterFields,
  financialAccountListResponse,
  financialAccountOut,
  financialAccountUpdateData,
} from "@cubby/schemas/financial-account";
import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
  financialTransactionCreateInput,
  financialTransactionFilterFields,
  financialTransactionListResponse,
  financialTransactionOut,
  financialTransactionUpdateData,
} from "@cubby/schemas/financial-transaction";
import {
  deleteStatementRowsInput,
  findStatementRowDriftInput,
  findStatementRowDriftOut,
  listStatementImportsInput,
  listStatementRowsInput,
  recordStatementRowsInput,
  recordStatementRowsOut,
  statementImportListOut,
  statementRowListOut,
  statementRowSummaryInput,
  statementRowSummaryOut,
  statementRowWriteOut,
  updateStatementRowsInput,
} from "@cubby/schemas/statement-row";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  defineSlim,
  READ_ONLY_CLOSED,
  registerEntityCrudToolset,
  registerRouterTool,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";

const slimFinancialAccount = defineSlim(
  financialAccountOut,
  (row) => row as never,
);
const slimFinancialTransaction = defineSlim(
  financialTransactionOut,
  (row) => row as never,
);
/**
 * Ordinary CRUD plus a durable statement ledger. The long-standing rule here —
 * no importer, no provider upsert, no automatic matcher — is a ban on automated
 * **decisions**, not on durable **state**, and `record_statement_rows` does not
 * cross it: it stores provider rows verbatim as evidence.
 *
 * Nothing in this file resolves a Financial Account, links a Purchase, creates a
 * Financial Transaction, or declares two rows the same charge. Match state is
 * derived at read time from `sourceRefs`, never stored, and the only mutable
 * fields on a statement row are the judgments an agent explicitly writes.
 * Reconciliation agents keep every judgment; Cubby only remembers what they
 * judged against.
 */
export function registerFinancialTools(server: McpServer) {
  registerEntityCrudToolset(server, {
    entity: "financialAccount",
    entityPlural: "financial_accounts",
    // No `create`/`update` override: those singular tools no longer register
    // (batch is on by default), so only `get`'s camelCase-vs-shortcode name
    // needs correcting here.
    names: { get: "get_financial_account" },
    createInput: financialAccountCreateInput.shape,
    updateShape: financialAccountUpdateData.shape,
    filterFields: financialAccountFilterFields,
    mcpListOut: financialAccountListResponse,
    out: financialAccountOut,
    slim: slimFinancialAccount,
    sort: { orderBy: "name", direction: "asc" },
    get: (caller, id) => caller.financialAccount.getByID({ id }),
    create: (caller, params) => caller.financialAccount.create(params),
    descriptions: {
      list: "List Financial Accounts. IDs are FAC- shortcodes. Accounts identify statement and receipt sources; they never hold Cubby spend. Filter by search, identity kind, provisional status, last four, source, or external account ID.",
      get: "Get a Financial Account by FAC- shortcode. Identity and sourceAliases are complete replacement values on update: read, merge locally, then write the full array/object.",
      create:
        "Create a Financial Account, including provisional accounts such as Visa ····NNNN. Source aliases are evidence, not finance-provider synchronization.",
      update:
        "Update a Financial Account. `identity` and `sourceAliases` replace their complete values; read–merge–write to preserve existing evidence.",
      delete:
        "Soft-delete Financial Accounts. Deletion is refused while live Financial Transactions reference the account.",
    },
  });
  registerEntityCrudToolset(server, {
    entity: "financialTransaction",
    entityPlural: "financial_transactions",
    names: { get: "get_financial_transaction" },
    createInput: financialTransactionCreateInput.shape,
    updateShape: financialTransactionUpdateData.shape,
    filterFields: financialTransactionFilterFields,
    mcpListOut: financialTransactionListResponse,
    out: financialTransactionOut,
    slim: slimFinancialTransaction,
    sort: { orderBy: "postedDate", direction: "desc" },
    get: (caller, id) => caller.financialTransaction.getByID({ id }),
    create: (caller, params) => caller.financialTransaction.create(params),
    descriptions: {
      list: "List Financial Transactions. IDs are FTX- shortcodes. Filter by account, Purchase or presence, kind, status, source/reference, merchant/search, amount, and transaction or posted dates. Amounts are settlement evidence and never enter spend.",
      get: "Get one Financial Transaction by FTX- shortcode.",
      create:
        "Create settlement evidence. Positive amounts are charges/outflows; negative amounts are refunds/inflows. Allocate it across the Purchases it settled via `allocations` ([{purchaseId, amount}]), which must sum to `amount` and share its sign — one real card line can settle several orders. `purchaseId` is shorthand for a single allocation of the full amount; supplying both is rejected unless they agree. Omit both to leave it unmatched. Posted entries require postedDate. Preserve statement/provider evidence in sourceRefs when available: a posted transaction with no sourceRefs may leave its Purchase's settlement_reference data-quality check unresolved unless the linked account itself supplies qualifying cash evidence.",
      update:
        "Update a Financial Transaction, for example when a pending refund posts, or to record which Purchases an existing transaction settled. `allocations` ([{purchaseId, amount}]) replaces the complete set and must sum to the transaction's `amount` and share its sign — pass [] to unallocate. `purchaseId` is shorthand for one allocation of the full amount; supplying both is rejected unless they agree. `sourceRefs` likewise replaces the complete array; read–merge–write when appending statement evidence. Posting without sourceRefs may leave the linked Purchase's settlement_reference gap unresolved unless the account supplies qualifying cash evidence.",
      delete:
        "Soft-delete Financial Transactions. Deleted and void transactions do not participate in Purchase reconciliation.",
    },
  });

  registerRouterTool(server, {
    name: "preview_financial_statement_import",
    description:
      "Preview client-parsed Monarch statement rows before recording settlement evidence. Cubby accepts normalized rows only — never a CSV path, upload, or file contents. Pass at most 200 rows. Monarch charges are negative in the export and are normalized to positive Cubby outflows; credits become negative. The preview derives a stable source reference from account/date/amount/original statement, resolves an existing Financial Account only when unambiguous, and returns already_recorded, ready_to_create, possible_existing, unresolved_account, or indistinguishable_duplicate for each row. Unresolved rows include a non-persisted provisional Account suggestion. This tool is read-only: it never creates Accounts, Financial Transactions, Purchases, or links. Create only user-approved ready_to_create rows afterwards with create_financial_transactions using the returned proposed fields and accountId, then review every per-item result.",
    inputSchema: financialStatementImportPreviewInput.shape,
    outputSchema: financialStatementImportPreviewOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) =>
      caller.financialTransaction.previewStatementImport(params),
  });

  registerRouterTool(server, {
    name: "record_statement_rows",
    description:
      "Record client-parsed provider statement rows verbatim, as the evidence Cubby is reconciled against. NOT an importer: it creates no Financial Account, no Financial Transaction and no Purchase link, and makes no match. Cubby accepts normalized rows only — never a CSV path, upload, or file contents. Pass at most 500 rows per call; the batch is found-or-created by (source, fingerprint), so chunking one export across calls is expected. The server derives each row's stable identity from account/date/amount/description, so re-submitting the same export inserts nothing and returns every row as unchanged. `providerAmount` is the export's own signed figure (Monarch signs charges negative); Cubby's outflow-positive amount is derived from it. Set `dateKind` to whichever date the export carries — providers disagree on posting vs transaction date, and recording which one this export used is the point. Set `dryRun: true` to derive the identities and report what a real call would insert without writing anything — the server owns the hash, so this is the only way to learn whether a chunk was already recorded.",
    inputSchema: recordStatementRowsInput.shape,
    outputSchema: recordStatementRowsOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.statementRow.record(params),
  });

  registerRouterTool(server, {
    name: "list_statement_rows",
    description:
      "List recorded statement rows with their derived match state. `unmatched` is the drift worklist: a provider row with no live Financial Transaction carrying its source reference. `matched` returns the FTX- shortcode that claims it. `ignored` and `superseded` are off the worklist by an agent's explicit judgment. Filter by source, account (FAC- shortcode), match state, disposition, date range, amount range, or a search over the raw statement description. To close an unmatched row, append its source reference to the right transaction with update_financial_transactions (read–merge–write on sourceRefs); the row flips to matched on the next read, with no write to the row itself.",
    inputSchema: listStatementRowsInput.shape,
    outputSchema: statementRowListOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.list(params),
  });

  registerRouterTool(server, {
    name: "get_statement_row_summary",
    description:
      "Count and total statement rows by match state for a filter — total, matched, unmatched, ignored, superseded, and the unmatched dollar amount. Use it to size the remaining drift before working it, or to confirm a bulk disposition landed.",
    inputSchema: statementRowSummaryInput.shape,
    outputSchema: statementRowSummaryOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.summary(params),
  });

  registerRouterTool(server, {
    name: "list_statement_imports",
    description:
      "List recorded provider exports, newest first, with rows actually stored versus the count the client declared. A stored count short of the declared one means a chunked ingest was never finished.",
    inputSchema: listStatementImportsInput.shape,
    outputSchema: statementImportListOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.imports(params),
  });

  registerRouterTool(server, {
    name: "find_statement_row_drift",
    description:
      "Find charges recorded TWICE under two identities. A row's identity hash covers its raw description, so a charge re-exported after its descriptor firms up (`AMAZON MKTPLACE PMTS` becoming `AMAZON MKTPL*XD8AR9RG3`) mints a second identity for money already recorded — 9 of 188 rows in one Monarch export. Groups live, unsuperseded rows by (source, accountDescriptor, statementDate, providerAmount) and returns groups holding more than one, oldest row first so rows[0] is the likeliest predecessor. By default only groups spanning TWO exports are reported: one export speaks one descriptor vocabulary, so two of its own rows differing only in description are two real charges (two payroll deposits, two coffees) rather than one charge seen twice — on this ledger that split is exact, 9 real pairs all cross-batch against 240 same-batch coincidences. Pass includeSameBatch to see them anyway. Still advisory: read the descriptions before acting. The remedy is update_statement_rows with `supersededByExternalId` on the predecessor, which stays an explicit per-row judgment. Rows already superseded drop out, so the list shrinks as it is worked.",
    inputSchema: findStatementRowDriftInput.shape,
    outputSchema: findStatementRowDriftOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.drift(params),
  });

  registerRouterTool(server, {
    name: "update_statement_rows",
    description:
      "Write judgments onto statement rows. Accepts ONLY judgment fields — the provider's own columns are immutable after ingest. Address rows either by {source, externalIds} for a handful, or by {filter} for a bulk pass over everything a list filter selects; an empty filter is refused rather than treated as every row. Set disposition 'ignored' with both a reason and a note to take rows off the worklist permanently — that is the intended move for the large tail of consumer spend Cubby does not model. `accountId` records which account a row belongs to, and `supersededByExternalId` links a pending row to the posted row that replaced it (a pending row that posts on a different date is genuinely a different row, and superseding requires the explicit id selector because the successor is one specific row).",
    inputSchema: updateStatementRowsInput.shape,
    outputSchema: statementRowWriteOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.statementRow.update(params),
  });

  registerRouterTool(server, {
    name: "delete_statement_rows",
    description:
      "Soft-delete statement rows. Rare by design: a row that will never match should be dispositioned 'ignored' with its reasoning, which keeps the evidence and the audit trail. Delete only rows that should never have been recorded, such as a mis-parsed export.",
    inputSchema: deleteStatementRowsInput.shape,
    outputSchema: statementRowWriteOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (caller, params) => caller.statementRow.delete(params),
  });
}
