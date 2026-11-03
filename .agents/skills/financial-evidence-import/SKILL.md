---
name: financial-evidence-import
description: Import financial evidence into Cubby from Monarch MCP or Monarch, Mint, Copilot and Apple Card CSV exports. Use for historical backfill, routine transaction sync, source revisions or confirmed withdrawals; order and receipt itemization belongs to purchase-import.
---

# Financial evidence import

Claude and Codex fetch or parse authorized source evidence, normalize it, and
call Cubby `finance` with `action: "record"`. Read the live tool schema
and [source-transaction-record.ts](../../../packages/schemas/src/source-transaction-record.ts) before
building requests. That schema owns field names and batch limits. This skill
does not write back to Monarch. Pi integration is deferred.

Cubby owns durable scheduling, matching, suggestions, booking and guarded
corrections. Record evidence and inspect its receipts; do not chain transaction
creation, reference attachment, Expense booking or account merges after intake.
Report unresolved account/identity/correction decisions through existing review
surfaces. Order and receipt work uses [purchase-import](../purchase-import/SKILL.md).

## Monarch MCP collection

1. Discover the connected Monarch tools and their actual capabilities. Inventory
   authorized accounts and transaction access, including hidden/manual accounts.
   Flag Finicity-connected accounts as unsupported by Monarch MCP; do not mark
   them covered or change their connection. Distinguish unavailable accounts
   from accounts with an enumerated empty window. Keep budgets, holdings, goals
   and balance-history import outside this workflow.
2. Backfill the agreed historical account/date scope first. After historical
   evidence and spending reconciliation are verified, routine pulls use a
   rolling two-week overlap. Older edits require a targeted older refresh;
   ordinary pulls cannot detect them. Enable recurrence only on explicit
   instruction after verifying the execution host, credentials, cadence and
   replay. This skill itself installs no scheduler.
3. Enumerate by account and bounded date window, recording expected count,
   fetched occurrences, IDs, signed totals and visibility for every partition,
   including empty ones. Follow real pagination when available. The investigated
   Monarch tool exposed no cursor/offset and capped detailed responses at 20;
   recheck the current tools. A returned continuation such as `next_offset` is
   usable only when the live request schema accepts it; a response hint alone
   does not supply a pagination capability. Verify account filters against every
   returned row's account ID: unknown filter keys can be silently ignored.
   An accepted request alone does not prove account scope. Use basic enumeration plus targeted detail reads,
   subdividing accounts/date windows until all identities can be enumerated.
   A nontruncated flag, a short page, count agreement or signed-total agreement
   alone does not prove completeness. Reconcile actual identity coverage with
   source counts, page boundaries and filters. A saturated minimum window that
   cannot be exhausted remains incomplete. Moving queries are not atomic
   snapshots: verify boundaries/counts again and report instability.
4. Validate currency, sign, date meaning, provider-ID scope/stability, hidden
   visibility, manual records and split parent/child representation from actual
   source metadata. Unknown semantics remain a blocker to the affected mapping.
   Keep split metadata without representing both the parent and its category
   children as separate bank money. Source categorization does not allocate
   Expenses. Count each genuine occurrence, including identical purchases and
   zero values. Pending/posted status is optional: preserve explicit values;
   use `providerStatus: null` when unavailable. Observed MCP responses included
   pending transactions without a status label; absence of that label never
   establishes posting and does not by itself make enumeration incomplete.
5. Preserve the unmodified provider response in `providerData`. For Monarch
   MCP it is exactly `{"transaction": <GetTransactions row>, "account":
   {"id", "displayName"}}`: the raw row with its notes, tags, category,
   amounts, timestamps and IDs. Do not add derived keys such as description
   kind, date meaning, currency or pending flags. `providerData` is an
   annotation: a re-observation whose facts are unchanged keeps the first
   stored annotation and records as `unchanged`. Pass attested `providerTransactionId` and
   `providerAccountId` separately. Keep provider/account/connection scope with
   them; an ID is not globally unique merely because it looks unique. Unknown
   scope, reused IDs and conflicting revisions require review. Never replace a
   missing provider ID with a hash or a Cubby ID.

## Normalize and record

- `providerAmount` is charges-negative: Monarch keeps its sign; Copilot and
  Apple Card invert theirs; Mint debit is negative and credit positive.
  Preserve original signed values/direction in `providerData`. Cubby handles
  its own ledger sign. Validate supported currency before recording; never
  combine currencies or invent an exchange rate.
- Keep the provider account descriptor and full mask, raw description, merchant,
  category and notes. When bank-original description is unavailable, use an
  empty `rawDescription`; the cleansed text stays in `providerData` under its
  original field name.
  Set `dateKind` only from established date semantics; a
  date-shaped string alone establishes none. Unknown provider status is null,
  never an invented `posted` value. Include zero-value observations.
- Give each immutable collection a stable fingerprint of its exact retained
  source bytes, observation time and explicit account/date/visibility scope
  where proven. Keep new observations of changed provider facts; replay the
  same bytes with the same fingerprint/positions. Separate ID-less occurrences
  remain independent until explicit reconciliation establishes identity. Provider revisions are
  evidence, not permission to overwrite accepted money by arrival order.
  The server derives observation and charge identities. Do not compute
  external IDs or collapse rows by equal date/amount/description.
  For MCP, retain a snapshot envelope containing observation time, scope and
  raw responses; hash its exact bytes and assign unique, stable `rowPosition`
  values to its enumerated occurrences. A later pull is a new observation,
  while a retry reuses the envelope and positions unchanged.
- Submit at most the schema's row limit per call, with the same `import`
  metadata and total `rowCountDeclared` across chunks. Use `dryRun: true` to
  inspect normalization without scheduling or mutation. Then submit the same
  payload with `dryRun: false`. Preserve every receipt; resume an interrupted
  collection by replaying its exact requests, not by creating a delta import
  with a different declared count. A registered fingerprint proves neither
  complete recording nor completed reconciliation.
- Keep `complete: false` until every enumerated occurrence has been recorded
  and the server's `rowCountStored` agrees with the declared collection count.
  Reconcile inserted/unchanged/revised/refreshed results and sign warnings before a final completion call. For a proven account/window,
  supply `coverage: {account, from, to, visibility}` using the schema's date
  fields, with `account` equal to the row's provider account ID when available,
  otherwise its exact descriptor. Completion requires this single-account
  coverage; `visible` scope cannot prove all-account absence. Preserve a valid
  empty collection as an explicit empty window, rather than silently skipping
  it. If the live schema cannot express required scope/proof, report that gap.

### Withdrawals

`confirmedWithdrawals` requires **both** an exhaustive complete window in the
same source/account scope and explicit source confirmation that each named
provider record is absent. Check date movement, changed IDs, split replacement,
visibility changes and corroborating evidence first. Use the exact selector
required by the live tool, obtained from retained evidence. Never infer deletion
from one page, visible-only filters, a missing search result or an old file.
Uncertain disappearance remains unresolved. Retain original observations and
references; the server decides whether a guarded correction is eligible or
needs review. Withdrawal from one provider is not proof the charge never happened.

## Local CSV branch

Use the stdlib-only [parser](scripts/parse_statement_csv.py) for the four legacy
export schemas. It performs no network or Cubby writes:

```sh
python3 .agents/skills/financial-evidence-import/scripts/parse_statement_csv.py \
  /private/export.csv --output /private/evidence.json
```

Keep originals and generated JSON outside the repository and model transcript;
inspect aggregate summaries locally. Never print or commit private files.
The JSON contains a `summary` with per-account/day counts and signed totals,
and `batches` containing record requests. Each defaults to dry run and incomplete;
submit the batch object, not the wrapper. File SHA-256 uses exact bytes (including
BOM/newlines); `rowPosition` is the physical starting line including the header,
blank lines and quoted multiline cells. All original columns, including tags,
IDs, notes, status and source signs, survive in `providerData.fields`.
The parser supplies no coverage claim. Add a proven single-account window to
the metadata before the first write if justified; a mixed-account file can
prove file ingestion counts but cannot complete one account/window collection.
Report that limitation separately from missing rows or spending reconciliation.

Monarch `Id` is recognized; other attested ID/account-ID/status columns can be
selected with `--id-column`, `--account-id-column`, `--status-column`.
`--observed-at` preserves an established ISO observation time. Unknown status
stays null. Apple Card's Transaction Date is transaction-kind; other exports
default to unknown date-kind until verified. Unsupported/ambiguous headers,
invalid rows and missing columns fail the whole parse without printing source
data. A file proves its own row count, not exhaustive provider-window coverage.
Verify currency, account identity and export scope separately. Do not hand-edit
or transcribe thousands of evidence rows through a model.

## Inspect retained evidence

Use `entity_read.list` / `entity_read.search` with
`entity: "sourceTransactionRecord"` for the declared evidence projection and
`entity: "transactionImport"` for collection counts, scope and completion.
Read a selected `STR-` or `TIM-` through `entity_read.get`. Consult the live
schema for filters, related records and projection fields; the import fingerprint
alone proves neither retained membership nor complete coverage.

Use `finance_read.summary` to size reconciliation by match state and
`finance_read.drift` to investigate possible descriptor revisions. These are
workflow computations, not roster APIs. Judgment corrections use the declared
`entity.update` fields on `sourceTransactionRecord`; obtain record IDs from
retained reads before setting a reviewed successor. Transaction imports remain
read-only outside intake. Provider facts and memberships change only through
recording source evidence. The [evidence lifecycle](../../../docs/import-evidence-convergence.md#financial-evidence-entities)
owns create/merge restrictions and deletion guards.

For temporary review holds, retain prior judgments and a unique marker, keep the
cases visible in the member review, and count them as unresolved. If holding
depends on current booking eligibility, check that eligibility and apply the
hold atomically with the relevant source and transaction locks. Intake copies
judgments into later revisions: reopening must discover original rows and
marked descendants within the proven source identity. Restore only exact
temporary-hold matches and preserve every newer member decision; restoring a
fixed list of old row IDs can leave newer observations held.

Before reviewing a statement Suggestion, use `finance_read.preview_suggestion`
with its listed assessment ID, expected fingerprint and declared application.
Inspect the current financial, Purchase/Expense, vendor and settlement effects.
A stale refusal requires fresh evidence and review; listing or stored clean
status does not grant acceptance authority. Preview writes nothing, and explicit
Suggestions review validates the application again.

Supplying `booking` or `kindOverride`, or choosing a nonrecommended action,
requires `suggestions.review` with `verdict: "wrong"` and
`correction: { present: true, value: application }`, using the same
`application`. This includes a Create draft whose action stays unchanged but
whose booking choices are supplied. Preview checks financial effects; apply
also enforces this review-input contract.

Statement attachment also converges spending. A successful preview whose
spending result requires review is not ready to apply, even with no transaction
fields selected. Resolve that spending review first. For an already accepted
transaction with a separately authorized explicit booking, use the reviewed
classification below, then refresh the statement proposal and preview its
attachment against the completed booking. Preserve the accepted transaction
and inspect the resulting source references and allocations. A booking-lineage
refusal remains unresolved; never restore old Expense values or member
attributions to force attachment. A separately authorized identity-only repair
must merge the current reference set inside one transaction through the existing
writer; replacing a client-side snapshot can remove concurrent attachments.

### Booking classification and read-back

For an authorized explicit booking, check existing Purchases, Expenses and
settlement allocations before creating aggregate spending. Refresh that check
when resuming a retained proposal; a fresh booking preview checks the selected
transaction's state, not the completeness of a prior duplicate search.

Choose cost type from what was purchased: a membership service uses `services`,
even when the Vendor usually sells goods. Vendor-default spending categories
are suggestions, not evidence of the purchase's purpose. Resolve category IDs
against live records before previewing; a merged category's successor need not
fit the purchase. When category is uncertain, preserve supported booking under
the member's uncategorized-booking policy rather than inventing a category.

Keep issuer benefit credits separate from purchase charges. Equal amounts,
nearby dates and a membership benefit do not alone prove a credit allocation or
net household cost. Review their meaning and settlement independently. After
commit, read back the Purchase, Expense, allocation and attribution graph;
check effective category and beneficiary defaults rather than assuming empty
overrides mean uncategorized or Household. Preserve explicit member decisions
about who benefits independently of who funded the payment. Report booked gross
spending separately from unresolved credits.

## Completion

Report account/date/visibility partitions with expected, fetched and recorded
counts, proven empty windows, interrupted or unsupported scope, and replay
results. Separate evidence coverage from reconciliation and spending coverage:
historical backfill is complete only after existing Purchases/Expenses were
matched first and genuinely missing eligible spending was booked through Cubby's
shared rules/review. Transfers, card payments and ordinary income create no
Expenses. Report pending/unknown status, revisions, withdrawals, correction
reviews and failed durable work without claiming source capabilities from
synthetic tests. Routine success needs no per-row approval; unresolved decisions
remain in Suggestions and execution failures in existing Job/Run diagnostics.
