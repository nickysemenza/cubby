import {
  emailAtChecksum,
  emailImportInput,
  emailPurchaseDecisionInput,
  emailPurchaseDecisionOut,
  emailImportOut,
  correctEmailRelevanceInput,
  correctEmailRelevanceOut,
  reclassifyEmailsInput,
  reclassifyEmailsOut,
  rerunEmailPreviewOut,
} from "@cubby/schemas/email-actions";
import {
  mailImportOutcomesInput,
  mailImportOutcomesOut,
} from "@cubby/schemas/mail-import-outcome";
import {
  mailReadInput,
  mailReadOut,
  mailResolveInput,
  mailResolveOut,
  mailSearchInput,
  mailSearchOut,
  mailTriagePreviewInput,
  mailTriagePreviewOut,
} from "@cubby/schemas/mailbox-research";
import {
  commitAcceptedSourceOrderReconciliationInput,
  commitAcceptedSourceOrderReconciliationOut,
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  importOperationStatusInput,
  importOperationStatusOut,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  prepareSourceOrderReconciliationInput,
  prepareSourceOrderReconciliationOut,
} from "@cubby/schemas/purchase-import";

import { defineContract, mutation, query } from "~/contracts/define";

// Agent- and caller-facing (MCP `purchase_import`, `purchase_import_read`):
// the same writers serve Pi's Mail import and a member's Claude/Codex session.
export const purchaseImportContract = defineContract(
  "purchaseImport",
  {
    commitAcceptedReconciliation: mutation({
      description:
        "Product-only repair: sourceOrderId plus attach_only lines bind existing exact item Expenses using productId or newProduct {kind:'new'}. A known original uses an exact owned preparation. For unknown historical extraction, reviewedPreparation {run,stableOrderId} names a fresh preparation of the unchanged retained Email against this Purchase; new review provenance preserves the unknown historical snapshot. Rechecks ownership, original, item, identity and claims; unchanged repeats return alreadyApplied. Changes no money, payments or Inventory.",
      input: commitAcceptedSourceOrderReconciliationInput,
      output: commitAcceptedSourceOrderReconciliationOut,
      invalidates: ["expense", "product", "purchase", "runOnly"],
    }),
    correctEmailRelevance: mutation({
      description:
        "Correct a false-negative Email only after independently reading the exact message. Supply prior expectedChecksum, canonical reviewedChecksum and your reason. Recovers bounded original content with no models, Pi admission or routing-policy change; frozen import sources refuse.",
      command: { label: "Correct relevance", confirmation: null },
      input: correctEmailRelevanceInput,
      output: correctEmailRelevanceOut,
      invalidates: ["email"],
    }),
    emailImport: mutation({
      description:
        "Start Luna import for up to 50 selected Emails, each by its `id` (EML- code) and exact checksum as purchase_import.mail_search and purchase_import_read.mail_read return them, without a dollar allowance. An Email already linked to exactly one Purchase imports into that Purchase. Ownership, evidence and review gates still apply. An existing automatic admission retains its original authority. Automatic import admission follows the mailbox switch; selected imports do not enable it. Other paid models need their own authorization.",
      command: {
        label: "Import Email",
        confirmation: null,
        runIdsPath: "runIds",
      },
      input: emailImportInput,
      output: emailImportOut,
      invalidates: ["email", "runOnly"],
    }),
    /** Link or dismiss one Email for one Purchase (Purchase, Vendor and Email pages). */
    emailPurchaseDecide: mutation({
      description:
        "A member's review of one Email for one Purchase at the Email's checksum (`id` EML- code and checksum from purchase_import.mail_search or purchase_import_read.mail_read). `linked` links every order event of the Email that suggests or was decided for that Purchase, replacing another Purchase's link on those events, and marks the Email related; `dismissed` dismisses them. An import-accepted source cannot be dismissed. List an Email's pairs with entity_read on email (`purchaseLinks`) or the Email list filtered by purchaseId/vendorId.",
      command: { label: "Update Purchase link", confirmation: null },
      input: emailPurchaseDecisionInput,
      output: emailPurchaseDecisionOut,
      // Every Emails section reads the Email list, so the list tag refreshes
      // the Purchase, Vendor and account sections together.
      invalidates: ["email"],
    }),
    emailReclassify: mutation({
      description:
        "Rerun Relevance for at most 200 owned Emails (one Run per mailbox), refetching originals. The decision model handles routine messages; uncertain results may use the relevance model. Records history and automatically settles unaccepted negatives through protected content disposal. Completed/researching imports and unreadable refetches of retained evidence await acceptance. Accepted evidence, member resolutions and same-checksum independent reviews are preserved; disagreements report conflicts. Never admits import.",
      command: {
        label: "Reclassify Email",
        confirmation: null,
        runIdsPath: "runIds",
      },
      input: reclassifyEmailsInput,
      output: reclassifyEmailsOut,
      invalidates: ["email", "runOnly"],
    }),
    emailPreviewRerun: mutation({
      description:
        "Rerun the cheap extraction preview for one related, retained Email at its current checksum. Records the preview; never imports.",
      command: {
        label: "Rerun preview",
        confirmation: null,
        runIdsPath: "runId",
      },
      input: emailAtChecksum,
      output: rerunEmailPreviewOut,
      invalidates: ["email", "runOnly"],
    }),
    prepareReconciliation: mutation({
      description:
        "Persist a reviewed source-order preview with line bindings, Expenses, party cents, payments, allocations and spend delta. Changes no ledger or stock. Apply a finding with its reviewedFingerprint; changed state refuses. With sourceOrderId it is an optional read-only preview of commit_accepted_reconciliation.",
      input: prepareSourceOrderReconciliationInput,
      output: prepareSourceOrderReconciliationOut,
      invalidates: ["runOnly"],
    }),
    /** Persist an immutable proposed import; writes no Purchase, Expense, or Product. */
    prepare: mutation({
      description:
        "Persist an immutable proposed purchase import. Each order names its Vendor (`vendorId`, or `vendor.name` to reuse the Vendor its sender or website domain proves or an exact-name Vendor, else create one; similar candidates need `vendor.distinctFrom`) and its source: a retained Email (`mail_message`, key `gmail:<mailboxId>:<messageId>` and the checksum purchase_import_read.mail_read returned), a receipt photo, or a vendor export. Without `_runExecution.run`, a member's preparation opens its own import Run and returns its RUN- code. Returns stable order and line ids plus existing Vendor candidates (`vendorCandidates`) and Product candidates to reuse before creating one. Never writes Purchases, Expenses, or Products.",
      input: preparePurchaseImportInput,
      output: preparePurchaseImportOut,
    }),
    /** Commit one exact prepared import; replay-safe. */
    commit: mutation({
      description:
        "Commit one exact previously prepared purchase import (name its Run in `_runExecution.run`). Supply a deliberate defaultTrade, or a defaultProjectId whose effective defaults provide a trade, for principal lines. Every principal line maps to an existing Product shortcode, an explicit new Product, or unresolved; unresolved lines create a finding for review — never a speculative Product. A retained-Email source is linked to the Purchase as its confirmation. Replay-safe by operation id; rechecks targets and evidence. Commits never start Product research.",
      input: commitPurchaseImportInput,
      output: commitPurchaseImportOut,
      invalidates: ["purchase"],
    }),
    operationStatus: query({
      description:
        "The durable status and original result of one stable purchase-import operation id. Use it after an interruption instead of inventing a new id or blindly repeating a write.",
      input: importOperationStatusInput,
      output: importOperationStatusOut,
    }),
    mailImportOutcomes: query({
      description:
        "Read bounded immutable import outcomes for one owned Email, newest first. Read purchase_import_read.mail_read and lock a blind grade before revealing these predictions. Includes Assessment handles, imported lines/total or linked/unrelated/unresolved disposition and rule/model producer. Grade member-confirmed outcomes through suggestions.review_batch with intent history; grades never change the ledger.",
      input: mailImportOutcomesInput,
      output: mailImportOutcomesOut,
      readPolicy: "strong",
    }),
    mailRead: query({
      description:
        "Read one retained Email: addressing, subject and date headers, body as compact text (HTML converted when richer than the text part; `compacted`, `truncated`, `htmlBytes` report it), preheader, cue-first links and content images within size bounds (`linksOmitted`/`imagesOmitted` count the rest), structured data, attachments and checksum. A long compact body continues from each page's nextOffset as offset (null at the end); `truncated` means evidence is missing from the compact text. Raw HTML is never returned by default; includeHtml returns one raw HTML page instead, for interactive sessions only (a Run's coordinator is refused). acceptedSourceOrders supplies owned accepted-order handles and source identities for prepare_reconciliation, separately from lifecycle Purchase links. Pass attachmentId for original PDF/image bytes (at most 3 MiB). Start research from this original and its links.",
      input: mailReadInput,
      output: mailReadOut,
    }),
    /** Full classification preview from Gmail, including exception-only Luna; no publication. */
    mailTriagePreview: query({
      description:
        "Preview the full deployed classification of one retained Email's Gmail original: Jev/Clef triage, then Luna with bounded image evidence only when uncertain. Records only a diagnostic Run and model usage; never changes Relevance, observations or retained content. Pass decisionModel to pin Jev or Clef; omitted samples the live split. Returns the final classification/model, triage result/view, fallback result, image evidence/refusal diagnostics, Run, elapsed time and priced usage (unknown costs stay null).",
      modelBacked: true,
      readPolicy: "strong",
      input: mailTriagePreviewInput,
      output: mailTriagePreviewOut,
    }),
    /** Scoped live Gmail search for a missing original. */
    mailSearch: mutation({
      description:
        "Search the member's connected Gmail (Gmail search syntax; Spam and Trash are always excluded) to recover a missing original, e.g. by order number. Member searches atomically queue normal classification for new matches in resumable Runs; pending results remain uncertain until those Jobs run. Under Pi's Mail import Run matches are classified in that Run. Disabling automatic import never skips classification. Searching never advances mailbox coverage. Page with `nextPageToken`. With several connected mailboxes, pass `mailboxId`.",
      input: mailSearchInput,
      output: mailSearchOut,
    }),
    /** Record what one retained Email means for the member's Purchases. */
    mailResolve: mutation({
      description:
        "Resolve one retained Email at its checksum: `linked` names every supported Purchase in purchaseIds for a lifecycle event; optional settlement (only with event `refunded`) records a member-reviewed mapping to existing posted refunds and their accounts, which must explain every Purchase this Email links as refunded. Writes no money or stock. `unresolved` names the gap; `unrelated` clears unaccepted content while preserving metadata and provenance. Matching reviews replay while evidence remains current; conflicting reviews refuse.",
      input: mailResolveInput,
      output: mailResolveOut,
      invalidates: ["purchase"],
    }),
  },
  { exposure: "capability" },
);
