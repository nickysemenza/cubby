import {
  providerIdBackfillInput,
  applyProviderIdBackfillInput,
  providerIdBackfillOut,
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
    previewProviderIdBackfill: query({
      description:
        "Preview filling one missing Monarch provider ID on a selected retained original CSV member. Requires the complete original normalized parser occurrence, exact retained fingerprint and complete-file identity/ID occurrence positions from the explicitly authorized local parser. Holds ambiguous source, account, chronology or accepted ownership. Returns an apply guard; writes nothing.",
      readPolicy: "strong",
      input: providerIdBackfillInput,
      output: providerIdBackfillOut,
    }),
    backfillProviderId: mutation({
      description:
        "Fill only one missing providerTransactionId using the exact previewed original CSV proof and expectedGuard. Preserves frozen identities, evidence, positions, chronology, memberships, decisions and all accepted money/references. Retains a typed audit receipt for exact historical/recovered intake replay. Enqueues no refresh, Run, Job, Sweep or correction work. Repeat only the exact committed proof; changed evidence is held.",
      input: applyProviderIdBackfillInput,
      output: providerIdBackfillOut,
      invalidates: ["sourceTransactionRecord"],
    }),
    previewSuggestion: query({
      description:
        "Preview a statement Suggestions review draft against current evidence without writing. Pass the listed assessmentId, expectedFingerprint and declared application. Returns current transaction, Purchase/Expense, vendor and settlement effects or refuses stale/unsupported evidence. A successful preview does not apply the draft; explicit Suggestions review revalidates it again.",
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
    /** Advisory overlap candidates; equal fields do not establish charge identity. */
    drift: query({
      description:
        "Find possible source-evidence overlap for review, not proven duplicate transactions. Groups live, unsuperseded observations sharing source, accountDescriptor, statementDate and providerAmount when distinct charge keys exist. These fields can also describe genuine identical purchases; neither equality nor creation order establishes predecessor/successor identity. By default a group must contain a pair with no shared collection membership; includeSameBatch also admits groups whose pairs share collections. Historical membership can mix legacy and positioned evidence, so this filter does not prove occurrence identity or completeness. Read retained observations, collection memberships, provider identities/revisions and accepted settlement references before deciding. Preserve genuine occurrences and member decisions; use only a supported guarded reconciliation command after explicit source proof. This read performs no repair, creates no financial records and does not authorize bulk supersession. Truncated results are incomplete.",
      input: findSourceTransactionRecordDriftInput,
      output: findSourceTransactionRecordDriftOut,
    }),
  },
  { exposure: "capability", mcpToolGroup: "finance" },
);
