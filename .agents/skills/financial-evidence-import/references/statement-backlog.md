# Working the statement backlog

Recording normalized evidence discovers bank-event and purchase-event work.
Supported charges reconcile automatically. Source transaction records retain
observations, Transaction imports retain collection membership, and each record's
machinery shows unresolved inputs, decisions and baseline drift.

1. Read the current observation, occurrence identity and any accepted
   FinancialTransaction before deciding. Equal amount, merchant and nearby dates
   are candidates, never proof that two charges are one event. Preserve genuine
   repeated purchases and every source observation.
2. Use `finance.apply` with `observationId` and an `application` action:
   `create`, `attach`, `supersede`, `void`, `book` or `reject`. Supply an account
   only when its identity is established. An attach or supersession names the
   reviewed `transactionId`; `fields` explicitly select `amount`, `postedDate`
   and `status`. A `kindOverride` is a member or agent decision, separate from
   provider category evidence. Application reports `applied`, `waiting` or
   `rejected`, with remaining gaps.
3. Read ambiguous identity gaps before choosing same or distinct through the
   record's declared machinery action. `rejectedCandidateIds` explicitly identify
   financial candidates that are distinct. A second source's copy of one charge
   attaches to its established transaction. Provider IDs, physical row positions
   and collection membership retain their source-identity authority.
4. A supported statement charge books one bare Purchase, an aggregate Expense
   and an allocation. Recorded splits and Expense or purchaser overrides are
   durable decisions. `application.booking` carries reviewed booking choices;
   a Purchase waiting for order details requires its explicit booking decision.
   Read existing money and attribution before changing either. Baseline drift
   writes nothing until reviewed; never restore Expense values or attribution
   merely to make a derivation fit.
5. Transfer-pair Suggestions retain their own review path. Accept a reviewed pair
   with `suggestions.review`, verdict `correct`, intent `apply`, its listed
   fingerprint and `application {kind: "transfer_pair"}`. Cross-owner pairs
   require a LedgerTransfer. Review payment-app person counterparties and shared
   repayments under the [household ledger](../../purchase-import/references/household-ledger.md).
   Never invent a Vendor from a person's name, spending to close a cash balance,
   or an ATM fee. Retain unexplained cash and unsupported pairings for review.
6. Reject an observation that must not create a transaction through
   `finance.apply` with `application {action: "reject"}`. A rejection is durable;
   releasing it requires an explicit decision. Existing accepted spending or
   transfers remain retained and need their owning correction command. Every
   genuine household charge is in scope, including consumer spending.

Disappearance requires complete account/window coverage and explicit source
confirmation under [Withdrawals](../SKILL.md#withdrawals). Age or absence from a
later export alone does not authorize voiding a pending hold. Preserve source
holds, member decisions and accepted ledger rows throughout review.
