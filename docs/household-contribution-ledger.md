# Household contribution ledger

Status: accepted architecture for the consolidated household ledger.

## Domain boundary

`Expense.cost` remains the only source of spend. Expense Attribution records consumption and initial funding against that existing cost. A Ledger Transfer records one later movement between Ledger Parties. Financial transactions and external records are evidence; they do not multiply transfers or become spend.

The household report is cumulative as of a date. It includes only Expenses and
Ledger Transfers dated through that day, and excludes planned future Expenses:

```text
net contribution = initially outlaid + transfers sent - transfers received
position         = net contribution - consumed
```

Internal account moves have zero contribution effect. Positions are advisory when attribution or evidence is incomplete and are never labeled as debts.

Evidence completeness is intentionally present-day rather than historical: a
transfer shown in an as-of position is checked against the Financial Transaction
evidence currently attached to it, including evidence attached after that date.
This keeps historical positions date-bounded while surfacing whether their
supporting evidence is complete now.

## Standard mutations

LedgerParty and LedgerTransfer are standard entities with the ordinary create, update, delete, list, and get surface. A LedgerParty's kind is `member`, `guest`, or `household`; it has a standalone browser list and detail route (`/ledger-parties`), read-only for now — no create dialog in the browser. A LedgerTransfer moves value between parties and likewise has a standalone browser route (`/ledger-transfers`), also read-only for now.

Expense mutations carry the nested Expense Attribution and Source Claim fields needed to record consumption, initial funding, external source identity, source amount, and an explicit decision about any discrepancy. FinancialAccount mutations carry a nullable Ledger Party field identifying which party the account evidences. These fields preserve the surrounding Expense or FinancialAccount as the routed record.

A Source Claim accepts a provider row ID only as write-time key material. The server hashes it with the provider namespace into the versioned source key, then discards it; reads expose the key and normalized evidence, never the raw provider identifier or payload.

## Supported flows

- Attribute an Expense to one or more parties, the household collectively, or null when attribution is unknown.
- Claim an Expense's external source amount while retaining an explicit decision when amounts differ.
- Create, update, or delete a Ledger Transfer between parties, including reimbursements and same-party internal moves.
- List and get Ledger Parties and Ledger Transfers for review, including their own browser list and detail pages under Finance.
- Pair statement evidence to a transfer without treating mirrored rows as separate transfers.
- Review household-global positions and project-local initial funding, consumption, and gaps.

Project kind never implies attribution. Project reports include both recorded and
planned future Expenses because they describe the project’s full intended cost;
the household/as-of ledger excludes those future Expenses. Project reports do
not apply later transfers: transfers are household-global.

## Presentation and unknowns

Client labels are derived from party kind. Route-capable entity references elsewhere in the app are links; on this ledger page, Ledger Parties and Ledger Transfers still render as plain text — that is a presentation choice for this module now, not a routing limitation, since both gained their own browser list and detail pages (`/ledger-parties`, `/ledger-transfers`). Recorded Expense attributions win for their role. Without recorded funders,
reports derive funding from positive payment allocations; without recorded
beneficiaries, they use the singleton Household party. Missing, partial,
unavailable, and null-attributed evidence remains an explicit gap.

## Import boundary

Clients orchestrate provider reads from Splitwise, Gmail, Monarch, or local exports and send normalized reviewed changes through the standard mutations. Cubby receives no provider credentials, raw emails, file paths, or whole exports. There is no global transaction across providers or independent records. Each record can be resumed from durable Source Claims and evidence, so a partial import does not require a global rollback or batch receipt.

The [local journey coverage map](agents/core-journey-e2e.md) distinguishes
the tested Project/Task browser path from the still-missing full contribution
attribution journey.

## Card access, purchaser, and funding dates

A credit card's `primaryCardholderId` identifies its primary member independently
of the account's `ledgerPartyId` and inventory-owner default. `authorizedUsers`
records member memberships with inclusive `validFrom`/`validTo` dates (null is an
open endpoint). History details link each Ledger Party beside its date bounds on both web and
Apple clients. Issuer, network, and primary cardholder use reviewed Jev/Clef field
suggestions. Account identity and notes supply the evidence; a saved issuer or
member roster supplies choices, not proof. All live members and the full network
enum reach the model; missing, ambiguous or conflicting holder/network evidence
requires none. Saved issuer vocabulary and literal `Issuer:` lines supply issuer
choices; the model decides whether the account evidence supports a match.
Shared funding and purchase frequency do not establish card access. Issuer and
network are editable scalar projections of the existing identity object;
acceptance preserves its sibling fields and the account's explicit histories.

The generic suggestion framework chooses among scalar enum, reference or text
candidates. It cannot generate structured facts or dated history rows.
Authorized-user memberships, funding periods, card-number history and every
`validFrom`/`validTo` remain explicitly entered; no account-specific AI extractor
fills them. Provisional is cleared only through member confirmation.
A primary cardholder cannot also be an authorized user. Outside
those memberships, the household's sole-use rule identifies the primary member
as purchaser. Multiple paying accounts must all agree on that sole user.

Purchase `purchaserOverrideId` wins. Otherwise, use the sole-use rule at the
Purchase's receipt/order date, then the unique member identified by its linked
Vendor Account and accepted or explicitly linked Email evidence. Conflicting
identities or shared use without identifying evidence stays unknown. Suggestions
are not accepted evidence. Purchaser evidence includes conflicting mailbox and
vendor-account identities even where account-scoped Email views hide that mailbox. Missing Purchase dates cannot establish sole use.
Clearing the override restores inheritance. Purchase merges carry an override
when the survivor has none and refuse conflicting explicit purchasers. Source identities remain intact;
purchaser attribution does not change beneficiaries or inventory ownership.

Account `fundingPeriods` independently selects the funding party at each payment's
transaction date, not its posting date or the Purchase date. Inclusive periods
must not overlap. An empty history keeps the existing `ledgerPartyId` fallback;
gaps in a nonempty history and missing transaction dates remain unknown. Expense
funder rows override that derivation. Existing account inventory defaults keep
using their existing undated party and are unaffected by funding history.

Both effective purchaser and derived funding are calculated on reads. Correcting
history takes effect automatically, without a recompute action, preview, or
confirmation, and never rewrites explicit overrides. Existing stored attributions
remain explicit. Clear references in live account history before deleting,
merging, or changing the kind of a referenced party; primary cardholders must
also be detached before merging. Existing card-number history is unchanged.
