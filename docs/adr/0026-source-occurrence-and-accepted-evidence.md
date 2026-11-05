# ADR 0026: Source occurrence owns accepted bank evidence

Status: Proposed for independent money/identity review. Implements ADR 0025 decision 6;
amends only the bank-evidence ownership seam of ADR 0012.

## Decision

One proven SourceOccurrence owns current source judgment, selected observation,
account resolution, lifecycle and explicit accepted FinancialTransaction FK.
Immutable SourceTransactionRecords and collection memberships retain evidence.
Provider identity requires attested source/account/transaction IDs; a physical
position proves identity within its original collection only. Hash equality,
account labels, supersession and alias uniqueness never prove an economic event.

FinancialEvidenceAlias retains exact original strings and binding provenance,
including unresolved and tombstoned history. Aliases explain history and block
unsafe automatic actions; they never resolve current accepted ownership. Original
observation notes remain local. Unproven legacy observations retain their own
unresolved annotations and unchanged money. Missing source proof creates no new
member task. Existing member suppression remains owned by Suggestion.

Remove charge-key folding, copied revision judgments, the provider-scope compatibility
engine and settlement_ref ownership traversal together. Keep original successful
receipts, allocations, Expense attribution, claim decisions and queued work.

## Concurrency and preservation

Command/identity reservations precede sorted occurrence locks, then existing
settlement-party, Purchase, FinancialTransaction and Expense locks. Acceptance
uses a checked FK assignment under those locks. Version changes only with semantic
owner changes. Collection fingerprints and positions remain reserved through deletion;
completion and final membership are atomic. Provider revisions without ordering proof
have no selected head; reappearance remains held. Explicit replacement never transfers
ownership. Automatic correction requires fresh independent corroboration and unchanged
financial lineage.

The direct migration retains complete SourceTransactionRecord, TransactionImportRecord
and EntityExternalId preimages under archive, rebinds references/triggers and proves
all removed source fields by independent reconstruction. It compares unchanged
memberships and external bindings as full row multisets, checks exact IEEE money
round trips, and verifies inert archives. Other money and member choices do not change.
The RunStep gate refuses unfinished financial refresh work. No production migration,
native installation or preservation read-back is implied by a local fixture.
Pending advice, paid labels, suppressions and member decisions stay in the existing review. Unsupported identity is displayed as held rather than unmatched; retained transaction links are historical evidence, not accepted ownership. Missing proof creates no new task. An explicit audited SourceRecord identityResolution can confirm a distinct event, accept an exact existing transaction, or assign an unproven observation to an existing reviewed occurrence. Its reviewed fingerprint, owner version and complete historical binding set fence concurrent changes. Ignore judgments and original evidence survive. Automatic intake never makes that judgment.

## Consequences

More explicit evidence tables replace multiple competing ownership and state paths.
Ambiguous history remains ambiguous. Fresh previews use opaque SOC handles while
shipped dollar-number money fields keep their wire shape. ProviderData remains the
first annotation of equal normalized facts; per-membership fingerprints freeze new
collection replays. No scheduler or recurrence is introduced.
