import {
  deleteStatementRowsInput,
  findStatementRowDriftInput,
  findStatementRowDriftOut,
  statementRowWriteOut,
  updateStatementRowsInput,
} from "@cubby/schemas/statement-row";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  deleteStatementRows,
  findStatementRowDrift,
  updateStatementRows,
} from "~/server/repo/statement-row";

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
 * Nothing in these tools or `statementRowContract` resolves a Financial Account, links a Purchase, creates a
 * Financial Transaction, or declares two rows the same charge. Match state is
 * derived at read time from `sourceRefs`, never stored, and the only mutable
 * fields on a statement row are the judgments an agent explicitly writes.
 * Reconciliation agents keep every judgment; Cubby only remembers what they
 * judged against.
 */
export function registerFinancialTools(server: McpServer) {
  registerRouterTool(server, {
    name: "find_statement_row_drift",
    description:
      "Find charges recorded TWICE under two identities. A row's identity hash covers its raw description, so a charge re-exported after its descriptor firms up (`AMAZON MKTPLACE PMTS` becoming `AMAZON MKTPL*XD8AR9RG3`) mints a second identity for money already recorded — 9 of 188 rows in one Monarch export. Groups live, unsuperseded rows by (source, accountDescriptor, statementDate, providerAmount) and returns groups holding more than one, oldest row first so rows[0] is the likeliest predecessor. By default only groups spanning TWO exports are reported: one export speaks one descriptor vocabulary, so two of its own rows differing only in description are two real charges (two payroll deposits, two coffees) rather than one charge seen twice — on this ledger that split is exact, 9 real pairs all cross-batch against 240 same-batch coincidences. Pass includeSameBatch to see them anyway. Still advisory: read the descriptions before acting. The remedy is update_statement_rows with `supersededByExternalId` on the predecessor, which stays an explicit per-row judgment. Rows already superseded drop out, so the list shrinks as it is worked.",
    inputSchema: findStatementRowDriftInput,
    outputSchema: findStatementRowDriftOut,
    annotations: READ_ONLY_CLOSED,
    call: (context, params) => findStatementRowDrift(context.readDb, params),
  });

  registerRouterTool(server, {
    name: "update_statement_rows",
    description:
      "Write judgments onto statement rows. Accepts ONLY judgment fields — the provider's own columns are immutable after ingest. Address rows either by {source, externalIds} for a handful, or by {filter} for a bulk pass over everything a list filter selects; an empty filter is refused rather than treated as every row. Set disposition 'ignored' with both a reason and a note to take rows off the worklist permanently — that is the intended move for the large tail of consumer spend Cubby does not model. `accountId` records which account a row belongs to, and `supersededByExternalId` links a pending row to the posted row that replaced it (a pending row that posts on a different date is genuinely a different row, and superseding requires the explicit id selector because the successor is one specific row).",
    inputSchema: updateStatementRowsInput,
    outputSchema: statementRowWriteOut,
    annotations: WRITE_CLOSED,
    call: (context, params) =>
      updateStatementRows(context.db, params, context.actorContext),
  });

  registerRouterTool(server, {
    name: "delete_statement_rows",
    description:
      "Soft-delete statement rows. Rare by design: a row that will never match should be dispositioned 'ignored' with its reasoning, which keeps the evidence and the audit trail. Delete only rows that should never have been recorded, such as a mis-parsed export.",
    inputSchema: deleteStatementRowsInput,
    outputSchema: statementRowWriteOut,
    annotations: WRITE_DESTRUCTIVE_CLOSED,
    call: (context, params) =>
      deleteStatementRows(context.db, params.selector, context.actorContext),
  });
}
