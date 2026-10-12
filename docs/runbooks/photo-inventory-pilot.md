# Photo-inventory onboarding

Onboarding a second household member's wardrobe/belongings photos through the
`photo-inventory-import` skill, end to end. Names below are synthetic — swap
in the real member, closets, and taxonomy gaps for an actual run.

1. Create the second member's `user` row directly (insert with their Google
   address, `emailVerified: true`) — e.g. `jordan.rivera@example.test`. They
   sign in with Google; `trustedProviders: ["google"]` links the account
   automatically because the provider-verified address matches the row. Then
   Settings → Member logins → link that login to their `LedgerParty`
   (`LPY-…`, synthetic: "Jordan Rivera").
2. Create person-scoped closet/dresser Locations for them (e.g. "Jordan's
   closet", "Jordan's dresser") — inventory in step 5 needs a real location
   to receive into.
3. Expand the Apparel taxonomy with one `entity.commands` call covering the gaps
   in [the apparel reference](../../.claude/skills/photo-inventory-import/references/apparel.md)
   (Loafers, Dress shoes, Slippers, and the rest of the Clothes list), then
   re-file any root-level `Apparel` Products into their new types — a Product
   classified only at the root predates this taxonomy and should move down.
4. Import their clothes with the [wardrobe import guide](../guide/wardrobe-import.md),
   choosing the second member as each Run's owner.
