# Import a wardrobe from photos

Photograph one person's clothes, upload them into a photo inventory Run, let an
agent propose one group per garment, then approve the groups. Approval creates
or reuses the Products and receives Inventory owned by that person. Nothing is
written to Products or Inventory before you approve.

A Run has no fixed photo limit. Split a large wardrobe into one Run per capture session so each Run
keeps one owner and a short list of locations.

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
notes, the owner, and a Location from your note. Where the owner or location is
unclear it leaves inventory out and says why. Then it stops.

## 4. Review and approve

Open the Run's page. For each proposed group you can move, split or merge
photos, switch a photo between item and label, pick a different existing
Product, or fix the name. Approve groups one at a time or as a batch, or
discard them. The Run completes when every photo is approved or discarded.

Approving a group receives Inventory at its Location owned by the Run's owner,
unless the group names another person. A group approved without inventory adds
the Product and photos only.

## 5. Afterwards

- **Confirm tags.** New Products appear in the Research queue for label review;
  ask the agent to work `product_label_review` so size and color match the tag
  photos.
- **Link orders.** Import the matching store orders with the purchase import
  workflow without receiving Inventory for garments already photographed, then
  confirm photo-to-order matches in the product match queue. Photos never
  create purchases or prices on their own.

See [One product, however its evidence arrives](product-identity-journey.md)
for how photos, orders and research converge on one Product.
