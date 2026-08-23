# Cubby

Cubby records a household's products, inventory, spending, and project history.

## Language

**Collection**:
A named, tag-backed grouping of Products and Location subtrees that are useful to browse together. A Collection is not a physical Location Area, a project Trade, or a Product compatibility tag.
_Avoid_: work area, trade, category

**Book Product**:
A physical book cataloged as a Product. Its ISBN is the book's GTIN identifier, editions or formats with distinct ISBNs are distinct Products, and a printed cookbook belongs here when recorded as a possession.
_Avoid_: Cookbook, EPUB, ebook

**Product movement**:
A dated acquisition, exit, discard, or uncertain change involving a Product, derived from a product-linked Expense or explicit Purchase provenance.
_Avoid_: Product purchase, sale event

**Unlocated product**:
A Product whose movements net to one or more units owned, with no live inventory entry placing it anywhere. Says where the record is silent, not that the thing is lost — a consumable that was used up reads the same way, because inventory never auto-decrements.
_Avoid_: lost product, missing inventory, shrinkage

**Person**:
A real human whose consumption or funding can be attributed. A Person is either a household member or a guest and may optionally link to one login.
_Avoid_: user, payer, pool

**Beneficiary**:
A Person who consumed some weighted share of an Expense. Beneficiary weights allocate existing `Expense.cost`; they never store or create money.
_Avoid_: owner, cardholder, debtor

**Funding source**:
The economic source that initially covered an Expense or participates in a later transfer. Every Person has a private person-backed source; a shared household fund is a separate source that may span several accounts.
_Avoid_: account owner, beneficiary

**Shared household fund**:
A durable joint pot, such as joint checking plus a shared credit card paid from it. Account membership never implies an individual ownership percentage; personal credit requires an explicit movement into the fund.
_Avoid_: Person, 50/50 account, payer

**Funding transfer**:
One logical, project-neutral movement between funding sources. Zero, one, or two FinancialTransactions may evidence it; those evidence legs never multiply the transfer or become spend. Public callers use its immutable `FTR-` shortcode, and the reviewed import envelope records actor provenance.
_Avoid_: Expense, reimbursement line item, Monarch row

**Contribution position**:
For one funding source, initial outlay plus transfers sent minus transfers received minus beneficiary consumption. It is a reconciliation position, not an automatic claim that someone owes money.
_Avoid_: debt, settlement balance

**Credit**:
A negative Expense that changes actual cost, such as a vendor refund. Person-to-person reimbursements are Funding transfers instead.
_Avoid_: contribution
