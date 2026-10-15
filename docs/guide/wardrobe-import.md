# Import a wardrobe from photos

Photograph one person's clothes, upload them into a photo inventory Run, let an
agent propose one group per garment, then approve the groups. Approval creates
or reuses the Products and receives Inventory owned by that person. Nothing is
written to Products or Inventory before you approve.

A Run holds up to 500 photos, and the app's photo picker stops a selection
there. Split a larger wardrobe into one Run per capture session, which also
keeps each Run to one owner and a short list of locations.

## Before you start

- **Connect an agent.** Claude Code uses Cubby's claude.ai connector; Codex
  uses Cubby's ChatGPT connector. Sign in once through each connector; both use
  OAuth, so never paste a token. Run the agent from a checkout of the Cubby
  repository so it can load the
  [photo inventory skill](../../.claude/skills/photo-inventory-import/SKILL.md).
- **Create the Locations** the clothes live in (for example "Closet", "Dresser
  — top drawer"). Inventory needs a real Location to receive into.
- **Turn on image work.** On the Problems page, the image work card must show
  queued work resumed and new upload processing enabled; otherwise photo
  descriptions and cutouts wait in the queue.
- **Keep an Apple device available** for cutouts: a Mac running Cubby, or an
  iPhone with Cubby in the foreground, with **Automatic work on this device**
  on in Settings. Cutouts are optional; the import works without them.

## 1. Take the photos

- One person's clothes per session. A Run belongs to exactly one owner.
- For each garment, take a full shot, then its size and care tags **right
  after it**. The agent groups photos in the order they were taken, so a tag
  must be shot right after its garment.
- Extra angles are fine; they attach to the same garment. Two identical
  garments in the same size and color become one Product with quantity 2.
- A pair of shoes is one item. Skip videos; they are not imported.
- Note the time whenever you move to another closet or drawer.

## 2. Upload and write the notes

In the iOS or macOS app, open **Photos**, select the photos, choose **Add to…**
then **Add to import run…**.

- **Owner**: whose clothes these are. It defaults to you.
- **Add a note**: write where the clothes were, by time window, plus anything
  the agent should know. For example: "9:15–9:40 Closet; 9:40–10:00 Dresser —
  top drawer. The three gray tees are the same shirt."
- **Import N photos** uploads them.

The note can only be written here, when the Run is created. If you forget it,
give the same locations to the agent in step 3.

To add more photos later, choose the same Run under **Open runs** instead of
**New run**. The Run keeps every photo in the order it was taken, so a later
batch slots in correctly.

Keep the app open until it shows **Photos uploaded**: the device reads tag text
from each photo while it uploads.

## What the Run does by itself

After upload the Run stays open and waits; it never creates Products on its own
and never expires while waiting for you.

- **On your device, during upload**: text recognition reads tags and labels.
- **In Cubby**: each photo gets a written description, when image work is on.
  While it is paused, the Run's page says so and grouping waits.
  Independent Apple description jobs wait for a capable participating device.
  Clef also proposes existing Products for supported single-object photos;
  open an image to see unconfirmed suggestions or why it abstained. No match
  changes a Product, attachment, or inventory without confirmation.
- **On a connected Apple device**: each garment photo gets a background-removed
  cutout, when a device is available. Tag photos are never cut out.

Nothing groups the photos until you start an agent in step 3.

## 3. Have an agent propose groups

Either:

- **Your own Claude Code or Codex session.** Ask: "Use the
  photo-inventory-import skill on RUN-4K7M." The run code is on the run page.
- **Cubby's hosted agent.** Open the Run in the app and choose **Start
  grouping**. It starts once every photo has its description, and requires the
  Cubby agent to be connected for your login.

The agent reads the photos in the order they were taken, checks each garment against existing
Products (including ones from past orders), and proposes one group per garment:
a name such as `Brand Model — Color, Size`, the tag text copied verbatim into
notes, the owner, and a Location from your note. Unclear sizes or other
identity details are called out in the proposal for you to resolve during review.
Where the owner or location is unclear it leaves inventory out and says why. Then it stops.

## 4. Review and approve

Open the Run's page. For each proposed group you can move, split or merge
photos, switch a photo between item and label, pick a different existing
Product, or fix the name. Approve groups one at a time or as a batch, or
discard them. The Run completes when every photo is approved or discarded.

Approving a group receives Inventory at its Location owned by the Run's owner,
unless the group names another person. A group approved without inventory adds
the Product and photos only.

The first choice in each group is its outcome: **Create this Product** or
**Attach to this Product**. Existing-Product comparisons are secondary and load
only when requested. Exact identifiers and color/size evidence are shown as
words, not a percentage: the heuristic rank is not a calibrated probability.
Observed identity remains separate from the chosen catalog destination.
Unresolved identity blocks applying the group until explicitly confirmed.
The low-level direct-commit API still permits legacy callers without a review
object; agents use proposals and stop for human approval.

**Create Product** saves the displayed draft and attaches its photos.
**Attach photos** appends photos while preserving Product fields, gallery order,
and cover. Select **Optional Product changes** to update specific name,
category, manufacturer, model, notes, or tags in the same transaction; the
review shows the old and proposed values. Review optional field changes on web;
the native client blocks applying hidden field edits. Labels stay labels and never become
covers. **Combine photo groups…** moves photos without changing their purposes;
the destination group's Product and stock decision survive. Product duplicate
reconciliation remains a separate reviewed operation in the
[product identity journey](product-identity-journey.md).

Choose a stock decision: catalog evidence, already counted, and historical or
sold all attach without changing Inventory. **Receive newly counted stock**
requires a real location, positive whole-number quantity and owner; create a
count or explicitly choose a compatible existing entry to add to. Historical
intent does not record a sale. Applying a group creates no Purchase or Expense.

Select resolved groups to apply a batch. Applying waits for saved edits and
checks each saved revision. Failed groups remain selected for retry, and applied
results stay in place. **Next unresolved item** is an explicit navigation action.
Retries recover committed receipts instead of repeating stock or field changes.

## 5. Afterwards

- **Link orders.** Import the matching store orders with the purchase import
  workflow without receiving Inventory for garments already photographed, then
  confirm photo-to-order matches in the product match queue. Photos never
  create purchases or prices on their own.

See [One product, however its evidence arrives](product-identity-journey.md)
for how photos, orders and research converge on one Product.
