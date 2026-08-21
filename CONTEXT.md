# Cubby

Cubby records a household's products, inventory, spending, and project history.

## Language

**Collection**:
A named, tag-backed grouping of Products and Location subtrees that are useful to browse together. A Collection is not a physical Location Area, a project Trade, or a Product compatibility tag.
_Avoid_: work area, trade, category

**Product movement**:
A dated acquisition, exit, discard, or uncertain change involving a Product, derived from a product-linked Expense or explicit Purchase provenance.
_Avoid_: Product purchase, sale event

**Unlocated product**:
A Product whose movements net to one or more units owned, with no live inventory entry placing it anywhere. Says where the record is silent, not that the thing is lost — a consumable that was used up reads the same way, because inventory never auto-decrements.
_Avoid_: lost product, missing inventory, shrinkage
