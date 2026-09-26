import {
  listStatementImportsInput,
  listStatementRowsInput,
  recordStatementRowsInput,
  recordStatementRowsOut,
  statementImportListOut,
  statementRowListOut,
  statementRowSummaryInput,
  statementRowSummaryOut,
  statementCsvCommitInput,
  statementCsvCommitOut,
  statementCsvFileInput,
  statementCsvPreviewOut,
} from "@cubby/schemas/statement-row";

import { defineContract, mutation, query } from "~/contracts/define";

export const statementRowContract = defineContract("statementRow", {
  previewCsv: query({
    native: "Preview local statement CSV in Apple apps using the shared parser",
    input: statementCsvFileInput,
    output: statementCsvPreviewOut,
  }),
  commitCsv: mutation({
    native: "Confirm statement CSV rows from Apple apps",
    input: statementCsvCommitInput,
    output: statementCsvCommitOut,
  }),
  record: mutation({
    mcp: {
      name: "record_statement_rows",
      description:
        "Record client-parsed provider statement rows verbatim, as the evidence Cubby is reconciled against. NOT an importer: it creates no Financial Account, no Financial Transaction and no Purchase link, and makes no match. Cubby accepts normalized rows only — never a CSV path, upload, or file contents. Pass at most 500 rows per call; the batch is found-or-created by (source, fingerprint), so chunking one export across calls is expected. The server derives each row's stable identity from account/date/amount/description, so re-submitting the same export inserts nothing and returns every row as unchanged. `providerAmount` is the export's own signed figure (Monarch signs charges negative); Cubby's outflow-positive amount is derived from it. Set `dateKind` to whichever date the export carries — providers disagree on posting vs transaction date, and recording which one this export used is the point. Set `dryRun: true` to derive the identities and report what a real call would insert without writing anything — the server owns the hash, so this is the only way to learn whether a chunk was already recorded.",
    },
    input: recordStatementRowsInput,
    output: recordStatementRowsOut,
  }),
  list: query({
    mcp: {
      name: "list_statement_rows",
      description:
        "List recorded statement rows with their derived match state. `unmatched` is the drift worklist: a provider row with no live Financial Transaction carrying its source reference. `matched` returns the FTX- shortcode that claims it. `ignored` and `superseded` are off the worklist by an agent's explicit judgment. Eligible unmatched rows may include advisory vendorInference derived from prior settled transactions with the same Merchant label; it neither matches nor links anything. Filter by source, account (FAC- shortcode), match state, disposition, date range, amount range, or a search over the raw statement description. To close an unmatched row, read then entity update(financialTransaction) to append its source reference; the row flips to matched on the next read, with no write to the row itself.",
    },
    input: listStatementRowsInput,
    output: statementRowListOut,
  }),
  summary: query({
    mcp: {
      name: "get_statement_row_summary",
      description:
        "Count and total statement rows by match state for a filter — total, matched, unmatched, ignored, superseded, and the unmatched dollar amount. Use it to size the remaining drift before working it, or to confirm a bulk disposition landed.",
    },
    input: statementRowSummaryInput,
    output: statementRowSummaryOut,
  }),
  imports: query({
    mcp: {
      name: "list_statement_imports",
      description:
        "List recorded provider exports, newest first, with rows actually stored versus the count the client declared. A stored count short of the declared one means a chunked ingest was never finished.",
    },
    input: listStatementImportsInput,
    output: statementImportListOut,
  }),
});
