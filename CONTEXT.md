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

**Ledger Party**:
An economic participant in household contribution accounting. Its kind is exactly member, guest, or household. A null attribution is unknown; unknown is not a party.
_Avoid_: payer, account owner, beneficiary

**Household Party**:
The intentional shared participant used when spending or consumption belongs to the household collectively. It is not a synthetic person and does not imply a debt.
_Avoid_: default person, pooled user

**Expense Attribution**:
A statement of who consumed an Expense and which party initially funded it. Attribution describes allocation of existing cost; it does not create money.
_Avoid_: reimbursement, ownership percentage

**Ledger Transfer**:
A project-neutral movement between Ledger Parties. A transfer is distinct from the statement records that may evidence it.
_Avoid_: Expense, contribution line, duplicate bank movement

**Source Claim**:
An assertion that an external source supports an Expense or transfer fact, including the source amount and any explicit decision about a discrepancy.
_Avoid_: imported truth, automatic match

**Contribution position**:
A party's cumulative outlay and transfer movement less attributed consumption. It is a reconciliation position, not an automatic claim that someone owes money.
_Avoid_: debt, settlement balance

**Credit**:
A negative Expense that changes actual cost, such as a vendor refund. A person-to-person repayment is a Ledger Transfer.
_Avoid_: contribution
