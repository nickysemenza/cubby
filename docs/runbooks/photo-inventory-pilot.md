# Photo-inventory pilot cutover

Onboarding a second household member's wardrobe/belongings photos through the
`photo-inventory-import` skill, end to end. Names below are synthetic — swap
in the real member, closets, and taxonomy gaps for an actual run.

1. Run `scripts/cutovers/import-run-photo-targets.expand.sql` against Neon
   before deploying the commit that ships
   `packages/schemas/src/entity-definitions/23-importRun.entity.ts` — it is
   expand-only (adds `ImportRun.notes` and `ImportRunTarget.imageId`/`position`
   plus their constraints) and `db:push` cannot diff CHECK bodies, so the
   constraints are hand-written there.
2. Deploy.
3. Create the second member's `user` row directly (insert with their Google
   address, `emailVerified: true`) — e.g. `jordan.rivera@example.test`. They
   sign in with Google; `trustedProviders: ["google"]` links the account
   automatically because the provider-verified address matches the row. Then
   Settings → Member logins → link that login to their `LedgerParty`
   (`LPY-…`, synthetic: "Jordan Rivera").
4. Create person-scoped closet/dresser Locations for them (e.g. "Jordan's
   closet", "Jordan's dresser") — inventory in step 7 needs a real location
   to receive into.
5. Expand the Apparel taxonomy with one `entity_batch` call covering the gaps
   in [the apparel reference](../../.claude/skills/photo-inventory-import/references/apparel.md)
   (Loafers, Dress shoes, Slippers, and the rest of the Clothes list), then
   re-file any root-level `Apparel` Products into their new types — a Product
   classified only at the root predates this taxonomy and should move down.
6. Upload a batch from the native app into a run: one member's clothes per
   capture session. The app creates a `photo_inventory` `ImportRun` with
   `ledgerPartyId` set to that member and `notes` describing
   location-by-time-window (e.g. "9:15–9:40am: primary closet; 9:40–10:05am:
   hallway dresser").
7. Have an agent work the run with the `photo-inventory-import` skill: it
   proposes groups with `propose_photo_groups` and stops. Review them on the
   run page (`/import-runs/RUN-…`) — move, split, or merge photos, fix
   item/label, pick an existing Product, then approve or discard — until
   `targetState: ["pending"]` returns nothing for that run. Cutouts appear only
   while image processing is enabled and a paired Apple device is connected.
8. Import the matching vendor orders with `purchase-import`, without receiving
   lines whose items were already photographed. Then work the product match
   queue (`/recommendations/workbench?kind=product-match`), merging each
   confirmed photo↔purchase pair into the purchase Product, and check
   `dataGap: product_unpurchased` for photo-created Products still missing a
   purchase.
