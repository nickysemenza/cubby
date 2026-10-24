import {
  findSourceTransactionRecordDriftInput,
  findSourceTransactionRecordDriftOut,
  recordSourceTransactionRecordsInput,
  recordSourceTransactionRecordsOut,
  sourceTransactionRecordSummaryInput,
  sourceTransactionRecordSummaryOut,
} from "@cubby/schemas/source-transaction-record";
import {
  statementSuggestionPreviewInput,
  statementSuggestionPreviewOut,
} from "@cubby/schemas/statement-suggestion";

import { defineContract, mutation, query } from "~/contracts/define";

export const sourceTransactionRecordContract = defineContract(
  "sourceTransactionRecord",
  {
    previewSuggestion: query({
      exposure: "view",
      note: "Read-only preview of a Suggestions review draft",
      readPolicy: "strong",
      input: statementSuggestionPreviewInput,
      output: statementSuggestionPreviewOut,
    }),
    record: mutation({
      description:
        "Record normalized financial evidence from an MCP source or client-parsed export; never submit file contents or paths. At most 500 observations per call. Resume a collection with identical source, fingerprint, observedAt, declared count and coverage. Scoped provider IDs identify revisions; retain providerAccountId, providerTransactionId, original descriptions and providerData. For ID-less exports preserve physical rowPosition. providerAmount is charges-negative; Cubby derives its outflow-positive amount. Zero records are retained without spending. Unknown providerStatus remains null; pending/unknown status does not prevent otherwise supported booking. Complete only an exhaustively enumerated account/window whose retained count equals its declaration. A visible-only query cannot prove withdrawal; confirmedWithdrawals additionally requires complete all-visibility coverage and source rechecking. Evidence plus the existing Sweep Job intent commit atomically. Dry runs and unchanged replays launch no financial work. Guarded corrections can revise or retire untouched generated lump bookings; edited/itemized/corroborated cases remain in Suggestions. Historical observations and settlement references are retained.",
      input: recordSourceTransactionRecordsInput,
      output: recordSourceTransactionRecordsOut,
      invalidates: ["sourceTransactionRecord"],
    }),
    summary: query({
      description:
        "Count and total source transaction records by match state for a filter — total, matched, unmatched, ignored, superseded, the dollar amount in total and per match state, and unmatchedCharges (distinct charges behind the unmatched observations). Size the remaining drift before working it, or confirm a bulk disposition landed.",
      readPolicy: "strong",
      input: sourceTransactionRecordSummaryInput,
      output: sourceTransactionRecordSummaryOut,
    }),
    /** Charges recorded twice under two identities (descriptor drift). */
    drift: query({
      description:
        "Charges recorded TWICE under two identities. A row's identity hash covers its raw description, so a charge re-exported after its descriptor firms up (`EXAMPLE STORE PENDING` becoming `EXAMPLE STORE POSTED`) mints a second identity for money already recorded. Groups live, unsuperseded rows by (source, accountDescriptor, statementDate, providerAmount) and returns groups holding more than one, oldest row first so rows[0] is the likeliest predecessor. By default only groups spanning TWO exports are reported: one export speaks one descriptor vocabulary, so two of its own rows differing only in description are two real charges rather than one charge seen twice. Pass includeSameBatch to see them anyway. Still advisory: read the descriptions before acting. Read both records through entity_read, then use entity.update(sourceTransactionRecord) to set `supersededByRowId` on the predecessor to the reviewed successor record ID. Superseded rows drop out, so the list shrinks as it is worked.",
      input: findSourceTransactionRecordDriftInput,
      output: findSourceTransactionRecordDriftOut,
    }),
  },
  { exposure: "capability", mcpToolGroup: "finance" },
);
