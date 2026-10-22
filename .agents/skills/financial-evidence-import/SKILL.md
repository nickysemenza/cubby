---
name: financial-evidence-import
description: Import financial evidence into Cubby from Monarch MCP or Monarch, Mint, Copilot and Apple Card CSV exports. Use for historical backfill, routine transaction sync, source revisions or confirmed withdrawals; order and receipt itemization belongs to purchase-import.
---

# Financial evidence import

Claude and Codex fetch or parse authorized source evidence, normalize it, and
call Cubby `source_transaction_records` with `action: "record"`. Read the live tool schema
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
   recheck the current tools. Use basic enumeration plus targeted detail reads,
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
5. Preserve the unmodified provider response fields in `providerData`, including
   notes, tags, category, original amount/currency, timestamps, revision tokens,
   split relationships and raw IDs. Pass attested `providerTransactionId` and
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
  category and notes. Set `dateKind` only from established date semantics; a
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
