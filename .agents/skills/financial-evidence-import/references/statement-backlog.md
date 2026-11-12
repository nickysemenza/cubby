# Working the statement backlog

Recording rows starts a routine Sweep that turns each unmatched charge into one
Transaction suggestion (`suggestions_read.list` with `family:
"statement_transaction"`; `groups: "account_month"` adds per account × month
sections with clean counts); `run.sweep {families: [{family:
"statement_transaction"}]}` reruns it after hand edits to transactions or
accounts, and `run_read.work_snapshot` follows its Steps. Burn the backlog
group by group, filtering a group with
`where {account: {in: [FAC-…]}, month: {in: [YYYY-MM]}}`:

1. Accept `clean: true` suggestions in batches of up to 100 with
   `suggestions.review`: verdict `correct`, intent `apply`,
   `expectedFingerprint` (the row's `fingerprint`), and `application {kind:
   "statement_transaction", action: <recommended>}`; an attach also names
   `transactionId`, the first candidate. For transfer/card-payment creates use
   the opposite-leg rule in step 5. Other creates are clean only when at least
   two of `create.votes` (category `rule`, model `label`, merchant `history`)
   name its kind and none disagrees, and `create.counterparty` is a business
   (on a stored-value account such as a payment app, history must say so). A
   card benefit, statement credit or issuer promotion is an `adjustment`, not a
   `refund` (a merchant giving money back for returned goods), even when it
   names the merchant of the purchase it offsets; merchant history is kept per
   direction, so a couple of corrected credits teach it.
2. Read every other suggestion before choosing. An attach candidate's model
   `label` is advisory — confirm the descriptors yourself, and below about $20
   read both. When every candidate is a different amount and labelled
   `different` with high confidence, the recommendation is `create`; the
   candidates stay listed, and accepting as is rejects them. Attach to a different candidate, tick `fields`, override the
   kind, or create anyway (`rejectedCandidateIds` listing every candidate) as
   verdict `wrong` with `correction {present: true, value: <the same
   application>}`. Applying a suggestion republishes the pending suggestions
   near it on the same account. A create still applies when a candidate
   appeared since review: the refusal names it, and listing it in
   `rejectedCandidateIds` retries the same review.
3. A charge with `siblings` has a same-amount charge from another export: the
   pair may be one charge whose descriptor firmed up. Within one source,
   when exact ID-less twins did not settle automatically, supersede the thinner row (generic `entity.update` on
   `sourceTransactionRecord`, setting `supersededByRowId` to the reviewed
   successor record ID) before creating either. Siblings from other sources
   mean their counts disagree (see [Matching](../../../../docs/import-evidence-convergence.md#matching)): book each real
   charge once and attach the other sources' copies to it. A `context`
   candidate with `contextReason: "claimed"` already settles another charge,
   so the recommendation is `create`; two visits for the same amount are two
   creates.
4. A person counterparty on a payment app is a shared-cost repayment, never a
   Vendor, and is never clean. Only a payment-app row (a stored-value account,
   or a Venmo, Zelle or Cash App descriptor) can have a person counterparty;
   elsewhere a person label or history reads as a business, such as a Square
   shop named after its owner or a bill naming the member. A payment to or from
   a household member is not a person counterparty: record it as a transfer
   with a Ledger Transfer between the members, never a Credit, even when it
   settles a shared dinner. An outgoing
   payment to a friend is your share of a shared cost: create it as `purchase`
   with the merchant set to the business the memo (`create.notes`) names, or
   the payment app's settle-up Vendor when it names none. An incoming one is a
   repayment: create it, then book it with `finance.book_transaction` as
   `economicRole: "reimbursement"` onto the Purchase it repaid when the memo
   names exactly one household charge from 14 days before to 2 days after at a
   plausible share, otherwise onto that year's settle-up Purchase (see the
   [household ledger](../../purchase-import/references/household-ledger.md)).
   Ignore bets, gifts and pools with a reason. Never save a person's name or a
   generic payment-app merchant string (such as a bare app name) as a Vendor
   or Vendor alias.
5. A `transfer` names the member's own balance account a cash-out or funding
   descriptor points at (Venmo-style and payout balances are `stored_value`;
   PayPal is read like a card). `transfer_pair` Suggestions stay reviewable on
   the global Suggestions page or through `suggestions_read.list`; Sweeps do
   not generate new ones. Accept using verdict `correct`, intent `apply`,
   `expectedFingerprint` and `application {kind: "transfer_pair"}`. It creates
   missing statement-backed legs and accepts the pair atomically. The family
   and statement creates share the
   [opposite-leg clean policy](../../../../docs/household-contribution-ledger.md#opposite-leg-clean-policy).
   Cross-owner pairs always need review and record a LedgerTransfer.
   An ATM withdrawal moves money into the `cash` account of the bank account's
   owner (a household checking's cash is the household's), so it is an
   internal move. Cash has no statement: review the proposal to create its
   full-amount leg on the owner's unique cash account, or enter the leg by
   hand. A proposed cash leg is never clean. Record the known ATM fee
   separately as a `fee` on cash; never infer a fee amount. Settle cash
   spending from that account against its Purchase. A cash account never
   reconciles: cash spent and not remembered stays as an unexplained balance on
   purpose. Never invent spending to close it, and never settle a Purchase from
   cash without evidence that the cash paid it. Review unresolved overlapping
   exports before creating a leg; confirmed observations must share one
   FinancialTransaction. Amount and nearby dates alone cannot establish charge
   identity.
6. Dismiss charges that should never become transactions with verdict
   `dismissed` and suppression `{scope: "statement_transaction", candidateKey:
   "<source>:<chargeKey>", fingerprint}`; prefer `disposition: "ignored"` with a
   reason when the whole row must never become a transaction, because that also
   settles every observation. Every real charge is in scope, consumer spend
   included: ignore only duplicates of another export's row, pre-Cubby rows and
   mis-parsed lines, never `not_modeled`.

A refusal (reviewed fields changed, a live candidate, a stale hold, an attach with
several candidates and no named `transactionId`) writes nothing. Labelling
republishes a suggestion as a new Suggestion, so a stale-Suggestion error means
re-list the group and review the replacement. Explicit pending-to-posted
evidence can support a reviewed supersession. Disappearance requires the
complete scope and explicit source confirmation in
[financial-evidence-import](../SKILL.md#withdrawals).
Age or absence from a later export alone does not authorize voiding a hold.
