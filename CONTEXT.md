# Cubby

Cubby records a household's products, inventory, spending, and project history.

## Language

**Collection**:
A named grouping of Products useful to browse together. Existing tag-backed Collections use direct Product assignments and inherited Location-subtree membership. Smart starters instead evaluate code-defined OR rules over Product manufacturer, exact tags, current Location/ancestor names, and directly linked actual Expense Trades. Every matching source is explained, and Products are counted once even when several sources match. Starter names and rules can be edited temporarily in a browser tab; refresh restores the defaults. Neither evaluation nor temporary editing writes tags or membership records. A Collection is not a physical Location Area, an Expense/project Trade, a future Work Area, or a Product compatibility tag.
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

**Meal preparation**:
One physical cooking of one Recipe occurrence planned into a Meal. A Meal Recipe occurrence has at most one preparation.
_Avoid_: inventory batch, recipe version

**Meal portion**:
A gram amount assigned to one Meal eater from a source Meal preparation at a target Meal. A portion is planned until explicitly confirmed as consumed.
_Avoid_: serving, inventory decrement

**Meal eater**:
A member or guest Ledger Party named on a Meal portion. The Household Party is not a Meal eater.
_Avoid_: household, unknown person
