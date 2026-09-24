# Cubby

Cubby records a household's products, inventory, spending, and project history.

## Language

**Plant**:
A cultivar or species the household sows or buys as a transplant. Grouped into a crop by its growing guide key; carries the household's verdict (yes, maybe, no) and cultivar days to maturity from its packet. Its Ingredient link, when set, is informational: one plant's harvest can become several ingredients.
_Avoid_: Crop ingredient, variety text, seed listing

**Planting**:
A crop or group grown together at a Location, linked to its Plant and optionally the Product it came from. An outcome (succeeded if it yielded anything, else failed) records how it went. Planned, growing, and finished describe its lifecycle. A partial transplant creates a child Planting that retains its source and sowing history; a whole transplant keeps the same record. Herbs and trees can stay growing through many harvests.
_Avoid_: seedling inventory, individual-plant ledger

**Garden Entry**:
A dated observation, photo batch, harvest, or recorded move at a Location, optionally associated with one Planting. The event's Location remains historical when the Planting moves. Harvest amounts are optional text and never change Inventory.
_Avoid_: Task, inventory transaction, readiness forecast

**Growing guide**:
Checked-in, source-specific planting windows associated with a Plant through its crop key. A guide preserves each source's microclimate and planting method. Household practice (how a crop is started, how often it is resown, crop-level days to maturity marked cited or estimate) is separate checked-in data under the same keys and never reads as a citation.
_Avoid_: seasonal plan, consensus recommendation

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
An economic participant in household contribution accounting, and the identity behind Device ownership and Image Sighting reports. Its kind is exactly member, guest, or household. A null attribution is unknown; unknown is not a party.
_Avoid_: payer, account owner, beneficiary

**Device**:
One registered native app instance on a phone or Mac, identified independently of a session or push token; a reinstall can retain the same identity. Optionally owned by a Ledger Party member and linked to the physical phone or Mac as a Product. An automatic-work switch, set on the device itself, and a remote-pause override, set from the web, together decide whether the job dispatcher sends it companion work; either one is enough to make it a plain viewer.
_Avoid_: session, connection, install id

**Image Sighting**:
One party's report that a stored Image exists in their photo library or cloud asset store, made by one reporting Device. A repeat report for the same image, owner, and asset key replaces the sighting's observation columns rather than duplicating it. Several sightings on one Image are ordinary: Photo Library sync can put the same asset on a member's phone and Mac, and a photo shared between members can be reported by more than one Ledger Party.
_Avoid_: upload record, device attachment, image copy

**Capture Attribution**:
How confidently an Image's derived capturer, timestamp, and location reflect reality. `none` is the default with nothing derived; `derived` means one Ledger Party's Image Sightings (or, failing that, embedded EXIF) settled it; `ambiguous` means several parties scored equally and no sighting decides it; `confirmed` means a member set it by hand, and a confirmed value is never recomputed.
_Avoid_: provenance, source, upload metadata

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
An entered quantity and unit assigned to one Meal eater from a source Meal preparation at a target Meal. Nutrition is derived from the current preparation and Recipe. Future portions are planned; today and past portions are logged according to the household date.
_Avoid_: serving, inventory decrement

**Meal eater**:
A member or guest Ledger Party named on a Meal portion or Meal food entry. The Household Party is not a Meal eater.
_Avoid_: household, unknown person

**Meal food entry**:
A quantity and unit of an Ingredient or Product, or named manual nutrient totals,
assigned to one eater at a Meal. Source conversions and nutrition remain live;
the entered amount is retained even when its nutrition cannot yet be calculated.
