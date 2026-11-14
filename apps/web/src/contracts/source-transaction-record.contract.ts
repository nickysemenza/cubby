import {
  findSourceTransactionRecordDriftInput,
  findSourceTransactionRecordDriftOut,
  recordSourceTransactionRecordsInput,
  recordSourceTransactionRecordsOut,
  sourceTransactionRecordSummaryInput,
  sourceTransactionRecordSummaryOut,
} from "@cubby/schemas/source-transaction-record";
import {
  statementDecisionInput,
  statementDecisionOut,
} from "@cubby/schemas/statement-decision";

import { defineContract, mutation, query } from "~/contracts/define";

export const sourceTransactionRecordContract = defineContract(
  "sourceTransactionRecord",
  {
    apply: mutation({
      description:
        "Apply, attach, book or void the current statement observation by recording decisions. Evidence is retained; ambiguous identity and missing order details remain visible in machinery. Attach names a reviewed live transaction; fields explicitly select the movement, posting date or status to copy. Reconcile an existing split before changing its movement.",
      input: statementDecisionInput,
      output: statementDecisionOut,
      invalidates: [
        "sourceTransactionRecord",
        "financialTransaction",
        "purchase",
        "expense",
      ],
    }),
    record: mutation({
      description:
        "Record normalized financial evidence from an MCP source or client-parsed export; never submit file contents or paths. At most 500 observations per call. Resume a collection with identical source, fingerprint, observedAt, declared count and coverage. Scoped provider IDs identify revisions; retain providerAccountId, providerTransactionId, original descriptions and providerData. For ID-less exports preserve physical rowPosition. providerAmount is charges-negative; Cubby derives its outflow-positive amount. Zero records are retained without spending. Unknown providerStatus remains null; pending/unknown status does not prevent otherwise supported booking. Complete only an exhaustively enumerated account/window whose retained count equals its declaration. A visible-only query cannot prove withdrawal; confirmedWithdrawals additionally requires complete all-visibility coverage and source rechecking. Evidence and kernel discovery commit atomically. Reconciliation derives bank events and statement spending; ambiguous identity, held baselines and missing order details remain visible as machinery gaps or drift. Historical observations and settlement references are retained.",
      input: recordSourceTransactionRecordsInput,
      output: recordSourceTransactionRecordsOut,
      invalidates: ["sourceTransactionRecord"],
    }),
    summary: query({
      description:
        "Count and total source transaction records by match state for a filter — total, matched, unmatched, ignored, superseded, the dollar amount in total and per match state, and unmatchedCharges (distinct charges behind the unmatched observations). Size the remaining drift before working it, or confirm a bulk disposition landed.",
      input: sourceTransactionRecordSummaryInput,
      output: sourceTransactionRecordSummaryOut,
    }),
    /** Advisory overlap candidates; equal fields do not establish charge identity. */
    drift: query({
      description:
        "Find possible source-evidence overlap for review, not proven duplicate transactions. Groups live, unsuperseded observations sharing source, accountDescriptor, statementDate and providerAmount when distinct charge keys exist. These fields can also describe genuine identical purchases; neither equality nor creation order establishes predecessor/successor identity. By default a group must contain a pair with no shared collection membership; includeSameBatch also admits groups whose pairs share collections. Historical membership can mix legacy and positioned evidence, so this filter does not prove occurrence identity or completeness. Read retained observations, collection memberships, provider identities/revisions and accepted settlement references before deciding. Preserve genuine occurrences and member decisions; use only a supported guarded reconciliation command after explicit source proof. This read performs no repair, creates no financial records and does not authorize bulk supersession. Truncated results are incomplete.",
      input: findSourceTransactionRecordDriftInput,
      output: findSourceTransactionRecordDriftOut,
    }),
  },
  { exposure: "capability", mcpToolGroup: "finance", readPolicy: "strong" },
);
