# Shared costs, repayments and group trips

The household contribution ledger
([architecture](../../../../docs/household-contribution-ledger.md)) owns the
model. This guide is the import recipe. Every amount below is synthetic.

## Which record

| Money movement                                                  | Record                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A vendor charge the household paid                              | Expense on its Purchase, settled by the card transaction                       |
| A vendor refund or host reimbursement                           | Negative principal Expense on the same Purchase                                |
| A non-member repays their share of a cost the household fronted | `reimbursement` Expense (a Credit) on the Purchase it repaid                   |
| One repayment covering several shared charges                   | Credit on one settle-up Purchase for the trip (vendor: the shared-expense app) |
| One member repays another member                                | Ledger Transfer between the two Ledger Parties                                 |
| A non-member's own purchase the household never paid            | Nothing; the household's share already nets out of repayments                  |

The project total is then the household's net cost: charges paid, less refunds
and Credits. Adjustment lines (tax, fees, refunds) inherit the Purchase's default
project; set `defaultProjectId` on each trip Purchase instead of tagging lines.

The settle-up Purchase is only a home for Credits: give the shared-expense app's
Vendor `orderEvidence: "not_expected"` and no vendor account. The app's payout
balance is a Financial Account (see Provider balances), and each repayment's
payment rail (a payment app, a bank) is the Financial Account of its transaction.

## Recipe

1. **Card and bank rows decide amounts.** Preview the statement rows for every
   account involved, including members' cards and payment-app accounts. A
   shared-expense export says which charges belong to the trip and who repaid;
   its amounts can be temporary holds, subtotals before tax and tip, or typos.
2. **Orders first.** Import each order with an Email or order page through
   `mail.import` or `purchase_import.prepare`. When Luna marks an order
   unresolved because the Email was unreadable, prepare it from the receipt or
   order page as a `vendor_export` source.
3. **Statement-only spend.** Venue food, a driver paid by bank transfer, and
   similar charges get a Purchase per vendor with one line per charge.
4. **Credits.** Book each incoming repayment with `finance.book_transaction` as
   `reimbursement`: onto the order it repaid when the memo or timing names one
   (lodging share, ticket share), otherwise onto the trip's settle-up Purchase.
5. **Members.** Record member-to-member repayments as Ledger Transfers with the
   transaction as evidence. Funding derives from the card each charge settled
   on, so funders need no tagging.
6. **Read back.** Every Purchase reconciles and settles; the project net equals
   the shared-expense app's household share plus household-only extras.

## Provider balances

A shared-expense app's payout feature (Splitwise Pay and similar) holds money
until it is cashed out. Model the balance as a `stored_value` Financial Account:
the repayment is income into that account and the later cash-out is a transfer
to the bank. A settle-up Credit then settles even before the cash-out.

## Example

Synthetic trip: lodging $1,200 paid on a member's card, four people share it.
Two guests repay $300 each by payment app; a third repays $300 through the
shared-expense app's payout, still held there. The fourth share is the
household's.

- Lodging Purchase: $1,200 Expense, settled by the card charge.
- Credits on the lodging Purchase: −$300, −$300 (payment-app transactions) and
  −$300 (stored-value balance transaction).
- Project net: $300, the household's share.
