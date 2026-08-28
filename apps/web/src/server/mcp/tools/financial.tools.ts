import {
  financialStatementImportPreviewInput,
  financialStatementImportPreviewOut,
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
  READ_ONLY_CLOSED,
  registerRouterTool,
  WRITE_CLOSED,
  WRITE_DESTRUCTIVE_CLOSED,
} from "./_shared";
/**
 * Durable statement-ledger workflows. The long-standing rule here —
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
  registerRouterTool(server, {
    name: "preview_financial_statement_import",
    description:
      "Preview client-parsed Monarch statement rows before recording settlement evidence. Cubby accepts normalized rows only — never a CSV path, upload, or file contents. Pass at most 200 rows. Monarch charges are negative in the export and are normalized to positive Cubby outflows; credits become negative. The preview derives a stable source reference from account/date/amount/original statement, resolves an existing Financial Account only when unambiguous, and returns already_recorded, ready_to_create, possible_existing, unresolved_account, or indistinguishable_duplicate for each row. Unresolved rows include a non-persisted provisional Account suggestion. This tool is read-only: it never creates Accounts, Financial Transactions, Purchases, or links. Create only user-approved ready_to_create rows afterwards with entity create(financialTransaction), then review every result.",
    inputSchema: financialStatementImportPreviewInput,
    outputSchema: financialStatementImportPreviewOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) =>
      caller.financialTransaction.previewStatementImport(params),
  });

  registerRouterTool(server, {
    name: "record_statement_rows",
    description:
      "Record client-parsed provider statement rows verbatim, as the evidence Cubby is reconciled against. NOT an importer: it creates no Financial Account, no Financial Transaction and no Purchase link, and makes no match. Cubby accepts normalized rows only — never a CSV path, upload, or file contents. Pass at most 500 rows per call; the batch is found-or-created by (source, fingerprint), so chunking one export across calls is expected. The server derives each row's stable identity from account/date/amount/description, so re-submitting the same export inserts nothing and returns every row as unchanged. `providerAmount` is the export's own signed figure (Monarch signs charges negative); Cubby's outflow-positive amount is derived from it. Set `dateKind` to whichever date the export carries — providers disagree on posting vs transaction date, and recording which one this export used is the point. Set `dryRun: true` to derive the identities and report what a real call would insert without writing anything — the server owns the hash, so this is the only way to learn whether a chunk was already recorded.",
    inputSchema: recordStatementRowsInput,
    outputSchema: recordStatementRowsOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.statementRow.record(params),
  });

  registerRouterTool(server, {
    name: "list_statement_rows",
    description:
      "List recorded statement rows with their derived match state. `unmatched` is the drift worklist: a provider row with no live Financial Transaction carrying its source reference. `matched` returns the FTX- shortcode that claims it. `ignored` and `superseded` are off the worklist by an agent's explicit judgment. Filter by source, account (FAC- shortcode), match state, disposition, date range, amount range, or a search over the raw statement description. To close an unmatched row, read then entity update(financialTransaction) to append its source reference; the row flips to matched on the next read, with no write to the row itself.",
    inputSchema: listStatementRowsInput,
    outputSchema: statementRowListOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.list(params),
  });

  registerRouterTool(server, {
    name: "get_statement_row_summary",
    description:
      "Count and total statement rows by match state for a filter — total, matched, unmatched, ignored, superseded, and the unmatched dollar amount. Use it to size the remaining drift before working it, or to confirm a bulk disposition landed.",
    inputSchema: statementRowSummaryInput,
    outputSchema: statementRowSummaryOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.summary(params),
  });

  registerRouterTool(server, {
    name: "list_statement_imports",
    description:
      "List recorded provider exports, newest first, with rows actually stored versus the count the client declared. A stored count short of the declared one means a chunked ingest was never finished.",
    inputSchema: listStatementImportsInput,
    outputSchema: statementImportListOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.imports(params),
  });

  registerRouterTool(server, {
    name: "find_statement_row_drift",
    description:
      "Find charges recorded TWICE under two identities. A row's identity hash covers its raw description, so a charge re-exported after its descriptor firms up (`AMAZON MKTPLACE PMTS` becoming `AMAZON MKTPL*XD8AR9RG3`) mints a second identity for money already recorded — 9 of 188 rows in one Monarch export. Groups live, unsuperseded rows by (source, accountDescriptor, statementDate, providerAmount) and returns groups holding more than one, oldest row first so rows[0] is the likeliest predecessor. By default only groups spanning TWO exports are reported: one export speaks one descriptor vocabulary, so two of its own rows differing only in description are two real charges (two payroll deposits, two coffees) rather than one charge seen twice — on this ledger that split is exact, 9 real pairs all cross-batch against 240 same-batch coincidences. Pass includeSameBatch to see them anyway. Still advisory: read the descriptions before acting. The remedy is update_statement_rows with `supersededByExternalId` on the predecessor, which stays an explicit per-row judgment. Rows already superseded drop out, so the list shrinks as it is worked.",
    inputSchema: findStatementRowDriftInput,
    outputSchema: findStatementRowDriftOut,
    annotations: READ_ONLY_CLOSED,
    call: (caller, params) => caller.statementRow.drift(params),
  });

  registerRouterTool(server, {
    name: "update_statement_rows",
    description:
      "Write judgments onto statement rows. Accepts ONLY judgment fields — the provider's own columns are immutable after ingest. Address rows either by {source, externalIds} for a handful, or by {filter} for a bulk pass over everything a list filter selects; an empty filter is refused rather than treated as every row. Set disposition 'ignored' with both a reason and a note to take rows off the worklist permanently — that is the intended move for the large tail of consumer spend Cubby does not model. `accountId` records which account a row belongs to, and `supersededByExternalId` links a pending row to the posted row that replaced it (a pending row that posts on a different date is genuinely a different row, and superseding requires the explicit id selector because the successor is one specific row).",
    inputSchema: updateStatementRowsInput,
    outputSchema: statementRowWriteOut,
    annotations: WRITE_CLOSED,
    call: (caller, params) => caller.statementRow.update(params),
  });

  registerRouterTool(server, {
    name: "delete_statement_rows",
    description:
      "Soft-delete statement rows. Rare by design: a row that will never match should be dispositioned 'ignored' with its reasoning, which keeps the evidence and the audit trail. Delete only rows that should never have been recorded, such as a mis-parsed export.",
    inputSchema: deleteStatementRowsInput,
    outputSchema: statementRowWriteOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (caller, params) => caller.statementRow.delete(params),
  });
}
