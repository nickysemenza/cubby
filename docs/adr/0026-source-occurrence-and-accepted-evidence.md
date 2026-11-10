# ADR 0026: Source occurrence owns accepted bank evidence

Status: Accepted; implemented. Implements ADR 0025 decision 6; amends only the
bank-evidence ownership seam of ADR 0012.

## Decision

Every SourceTransactionRecord belongs to one SourceOccurrence holding current judgment, selected observation,
account resolution, lifecycle and explicit accepted FinancialTransaction FK.
Immutable SourceTransactionRecords and collection memberships retain evidence.
Provider identity requires attested source/account/transaction IDs; a physical
position proves identity within its original collection only. Hash equality,
account labels, supersession and alias uniqueness never prove an economic event.

FinancialEvidenceAlias retains exact original strings and binding provenance,
including unresolved and tombstoned history. Aliases explain history and block
unsafe automatic actions; they never resolve current accepted ownership. Original
observation notes remain local. Unproven legacy observations receive singleton, explicitly held owners with unchanged money. Original annotations remain historical evidence; they no longer own current financial decisions. Missing source proof creates no new
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
Pending advice, paid labels and explicit financial decisions stay in the existing review. Financial presentation dismissals bind only their current recommendation fingerprint, never future events through alias history. Unsupported identity is displayed as held rather than unmatched; retained transaction links are historical evidence, not accepted ownership. Missing proof creates no new task. An explicit audited SourceRecord identityResolution can confirm a distinct event, accept an exact existing transaction, or consolidate a complete eligible owner into a provider occurrence. Its reviewed fingerprint, owner version and complete historical binding set fence concurrent changes. Ignore judgments and original evidence survive. Automatic intake never makes that judgment. Proof is not judgment: an attested provider row whose transaction ID, provider account and amount equal the single live observation of exactly one unproven owner, with no contradicting raw claims, upgrades that owner in place to the provider occurrence, keeping its account, disposition and history; differing facts still wait for head review. Any disagreement or ambiguity stays held for reviewed resolution.

## Consequences

More explicit evidence tables replace multiple competing ownership and state paths.
Ambiguous history remains ambiguous. Fresh previews use opaque SOC handles while
shipped dollar-number money fields keep their wire shape. ProviderData remains the
first annotation of equal normalized facts; per-membership fingerprints freeze new
collection replays. No scheduler or recurrence is introduced.

Owner ruling: unproven observations stay held with unchanged money and retained paid/member review. Identity- or ownership-held charges publish no Transaction advice; generation supersedes their pending advice, keeping its rows and labels, so Source identity review is their one surface. Existing `entity.commands` supplies reviewed bulk resolution as independent SourceRecord updates, each with expectedDisposition and the observation/owner/history fences. An assign cannot discard a different original account or disposition. Held apply reports the held reason; held dismissal settles advice without suppressing a later live owner. Current publication supersedes old-key pending advice on the same observations and reuses paid labels only on exact model-input/policy agreement. Read summaries separate held historical links from holds without live historical links; weak sibling links are presentation/review evidence, never accepted ownership.

## Judgment-owner simplification

A non-null owner does not prove a bank event. The `unproven` kind/state pair forbids
accepted transactions until explicit review promotes it. This removes the parallel
ownerless financial annotation writer and its read branches. Original annotations,
local notes and reviewed replacements survive. Financial presentation dismissals
may be discarded when obsolete; explicit financial ignore decisions survive.

Reviewed consolidation keeps the provider head and transaction contents, guards
both owner versions and the complete evidence closure, and refuses contradictory
identity, judgments, amounts and direct historical money. A released owner retains
its reservation and preimage, with single-hop replay to the provider survivor. Clearing the
head precedes movement because membership FKs are immediate. Remaining source
overlaps do not become ready merely because one legacy owner was consolidated.
