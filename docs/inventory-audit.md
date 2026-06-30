# Inventory Audit / Session Flow

> Status: shipped in [#342], hardened + made phone-usable in [#347] and follow-up quick wins. The
> recount UI works on a phone; the **reconcile it implies is still not built** — "Mark complete"
> records that you visited a bin, not what changed. The decided design for that is in
> [§6](#6-redesign-direction). Read [§5](#5-known-rough-edges) before trusting a "complete" stamp.

This doc serves two readers: the **owner** (what the flow is for and how to run an audit — [§1](#1-purpose),
[§4](#4-how-to-use-it)) and a **future agent** (the pieces, the danger, the decided direction —
[§2](#2-concepts), [§5](#5-known-rough-edges), [§6](#6-redesign-direction)). It cites code by
**symbol / file**, not line number (line numbers drift every PR).

---

## 1. Purpose

The inventory audit is a **physical recount and reconcile** tool. You walk up to a shelf, bin, or
drawer, look at what is actually there, and fix the drift between what the database believes is
stored and what is physically on hand. That is the **primary** job: not data entry, not shopping —
*reconciliation*.

The contents are mostly **non-food garage stuff** — tools, hardware, brackets, boxes, gear — plus
some deep-pantry items. It is explicitly **not** a grocery app. That shapes everything: most items
are **not barcoded**, "quantity" is usually an integer count of physical units ("3 of these
brackets"), and the highest-value items are the hard-to-re-derive garage gear you'd never want to
silently lose.

The real use context is a **one-handed iOS PWA walk**. You are standing in the garage, phone in one
hand, going **location by location**: open a bin, confirm or correct its contents, move on. There is
also a lighter mode that matters just as much — the **quick spot-check**: you're standing at one
specific shelf, you just want to verify *this* bin and leave, not start a whole sweep.

A **secondary** goal rides along: catching **data-quality issues** while you're already looking —
duplicate entries, mislocated items, entries with no product link, junk auto-named rows.

Four facts the design is held to (status in parens):

1. **Phone-first, one-handed** — the hot path is thumb taps, not keyboard entry. *(partly: mobile
   nav, scanner sweep, bottom undo shipped; the row gesture + steppers are still §6 work.)*
2. **Location-at-a-time**, with a "what's left / jump to next" overview. *(shipped — the mobile
   location switcher.)*
3. **Recount that actually writes the fix** — a matching recount and a skipped one must not look
   identical in the database. *(not yet — the reconcile is the decided next milestone.)*
4. **Resumable** — a garage walk *will* background the app, lose signal, or get reloaded.
   *(partly: in-session progress now survives reload / refetch via localStorage; durable
   cross-device progress needs `verifiedAt`, decided in §6.)*

---

## 2. Concepts

### Session and root

A **session** is a recount pass over a **subtree** of the location tree. You pick a **root** location
(a garage, a room, a cabinet) and the session flattens its auditable descendants
(`flattenAuditableLocations` in `session-utils.ts`) into an ordered list you walk through. The root
rides in the URL as the `parentId` search param. With no `parentId`, the route gates on
**`ParentPicker`** to choose one.

> ℹ️ There **is** a per-location door: location detail / list pages render an "Inventory Session"
> button linking to `/inventory/session?parentId=<thisLocation>`, bypassing `ParentPicker`.
> `flattenAuditableLocations` includes the location *itself* at index 0 plus descendants, and the
> initial index is the first incomplete location else 0. So for a **leaf bin** this is effectively a
> single-bin spot-check — you land right on it. The narrower rough edges are in §5 #5.

### Navigating: sidebar (desktop) and switcher (mobile)

`SessionLocationList` is the shared body — the filterable tree of auditable descendants with
completion checkmarks and confirmed/total badges. Desktop mounts it in a sticky
`LocationWorkbenchSidebar`; mobile mounts it in `MobileLocationSwitcher` — a sticky header chip
("parent · bin X / N · done") that opens the same list in a bottom `Sheet`. `LocationReviewPane` is
the per-location screen: expected inventory rows, child-location rows, the Unknown tray, and
prev/next nav.

- **Expected** = inventory entries the DB has at this location.
- **Found** = what you confirm by checking rows off. Confirmation lives in a client `confirmedIds`
  `Set`, now **persisted per session root to `localStorage`** so it survives a reload or a
  tree-invalidating mutation (it is UX state only — never a source of truth for a write).
- **Unexpected** = items physically present but not in the expected set; add them via barcode/QR
  scan or manual product search in `SessionCaptureActions` / `ManualAdd`.

### The Unknown tray

Marking a row **"No"** (not here) `bulkMove`s the entry into a **parentless global "Unknown"
location**. Unknown is deliberately excluded from session roots and auditable descendants, so no
flow drains it — it's a limbo bucket that only grows. **This is accepted behavior** (see §6
Decisions), not a defect: "No → Unknown" is the relocate-to-limbo verb; there is no in-session
"it's gone / used up" remove yet.

### `lastBulkInventory`

`location.lastBulkInventory` is the **only persisted signal** that a location was audited. "Mark
complete" calls `touchLastBulkInventory` (location router), which just stamps it to `now()`. Two
traps: it records *that* you visited, never *what changed*; and it's **also stamped as a side effect
of any `bulkMove`**, so relocating one item marks the source location "audited" with zero recount.

### The `bulkProcess` reconcile engine (and `bulk-edit`)

`bulkProcessInventoryEntries` (`bulk.ts`) is a real reconcile engine: given a location and a batch of
entries, it removes every existing entry **not** in the submitted batch, then creates/updates the
rest. As of [#347] the removal is a **soft delete** (sets `deletedAt`, honoring the repo-wide
soft-delete invariant) — *not* a hard delete. **The session never calls it.** It lives solely behind
the `/inventory/bulk-edit` route, a desktop spreadsheet, which since [#347] also **refuses to submit
on a truncated or still-loading snapshot** (closing the silent-wipe-on-partial-load hole) and warns
when a location holds more entries than one page.

> **Agent note:** `bulkMoveInventoryEntries`' source-collapse on a full move intentionally stays a
> **hard** delete — soft-deleting it would leave a zero-qty ghost that `notDeleted()` hides but
> valuation/duplicate scans resurface. Keep the soft-delete scoped to the delete-missing branch.

---

## 3. The flow today

1. **`/inventory/session`** → if no `parentId`, `ParentPicker` to choose a root.
2. Navigate the bins: desktop via the sticky sidebar; **mobile via the header-chip switcher** (a
   bottom `Sheet` with the same filter, badges, tap-to-jump, and a QR scan with a "can't scan? enter
   code" fallback). Plus prev/next on the per-location action bar.
3. `LocationReviewPane` per location: expected rows with checkoff, child rows, the Unknown tray, and
   a sticky action bar (prev / next / mark complete) that respects the iOS safe-area + bottom nav.
4. Per expected row: **Yes** (adds to `confirmedIds` — display only, writes nothing); **adjust qty**
   (inline `AmountFieldGroup`); **No** → `bulkMove` into the global Unknown; **add unexpected** via
   barcode/QR scan (the scanner Sheet stays open for a continuous sweep, deduping repeat reads) or
   manual product search. Manual "create new" is a **name-only quick-create** (`product.quickCreate`,
   manufacturer defaulted) — no full `ProductForm`.
5. **Mark complete** → `touchLastBulkInventory`. **No reconcile happens** — confirmed, unconfirmed,
   and never-scrolled-to rows are treated identically.
6. **Undo** for moves surfaces as a bottom toast (sonner) with an Undo action.

The blunt summary: **checking items off and marking a location complete produces no database
change.** A recount where everything matches is indistinguishable from one where you scrolled past
40 items. The only durable artifacts are `bulkMove`s (relocations) and the `lastBulkInventory` stamp.

---

## 4. How to use it

> Reflects the flow **as it is today**, including its gaps.

### Running a real garage audit (subtree sweep)

1. Open `/inventory/session` and pick the **root** = the broadest thing you're auditing today (e.g.
   "Garage"). On a phone, use the **header chip** to see what's left and jump between bins.
2. Walk the bins. In each: tap **Yes** on what's present, **adjust qty** when the count drifted,
   **No** on what's missing, **add** anything unexpected (the scanner stays open — sweep a shelf of
   barcodes in one go; "create new" needs only a name).
3. **"No" sends the item to the global Unknown bucket — it does not delete it.** If a thing is truly
   gone/used up, there's no clean in-session verb yet; treat "No" as "relocate to limbo." You'll
   drain Unknown by hand later (or via MCP / bulk-edit).
4. **Mark complete** when the bin matches — remember this only stamps a timestamp, it does **not**
   persist a recount. Your green checks now survive a reload or editing a photo (localStorage), but
   they're still display-only.
5. If you genuinely need the destructive delete-on-omit reconcile, that's `/inventory/bulk-edit` on
   desktop — now soft-delete + truncation-guarded, but still a spreadsheet: eyeball the list before
   saving.

### Quick spot-check (one bin)

Open the **location's detail page** and hit **"Inventory Session"**. For a **leaf bin** it drops you
straight onto it — a real single-bin spot-check. Caveats: a **container** location opens its whole
subtree; an **already-complete** bin skips to the first incomplete descendant; the **global-nav**
entry forces `ParentPicker`; QR jump only resolves locations *inside* the chosen root. A
scan-*anything*-to-start spot-check is still §6 work.

---

## 5. Known rough edges

Ranked by what's left to fix (several earlier edges shipped — see §6 *Shipped*).

1. **The session never reconciles drift — its primary purpose.** "Mark complete" only stamps
   `lastBulkInventory`; checking "Yes" writes nothing; `bulkProcess` is never called from the
   session; and `lastBulkInventory` is also stamped as a `bulkMove` side effect, so a bin reads
   "audited" the instant one item is relocated. *Decided fix: gated "Done" + `verifiedAt` (§6).*
2. **No in-session "remove" verb.** The dominant real outcome — "it's gone / used up" — has no
   button; "No" only relocates to the global Unknown limbo, which nothing drains. (Owner chose to
   keep Unknown; the missing piece is an explicit per-item remove, part of §6.)
3. **The recount row gesture is slow and crowded.** Each row is a small Photo/Qty/Yes/No grid with
   the destructive **No** one thumb-slip from **Yes**; no tap-row-to-confirm, no swipe, no inline
   ± stepper — counting drift summons the keyboard. *Decided fix: row reframe (§6).*
4. **`bulk-edit` lacks a concurrency/staleness guard.** Truncation + loading are now guarded, but a
   stale snapshot racing a concurrent MCP/other-surface write could still delete-on-omit entries
   added since load. Add a staleness guard before relying on it for large locations.
5. **Spot-check degrades for containers and completed bins.** The per-location "Inventory Session"
   button is a real leaf-bin spot-check, but a container opens its whole subtree (no "this node
   only" scope), an already-complete bin teleports to the first incomplete descendant, and QR jump
   rejects out-of-root scans — so there's no scan-*anything*-to-audit-this-bin mode.
6. **Data-quality is unbuilt.** The session surfaces no duplicate/mislocation/missing-link flags even
   though `findDuplicateUniqueProducts` exists on another surface. *Part of §6 P-data-quality.*

---

## 6. Redesign direction

### North star

A **phone-first, location-at-a-time recount** where the dominant gesture is forgiving, the
destructive ones are deliberate, and **"I walked this bin" is a durable fact** — not a volatile
checkbox. You stand at a shelf, land on its recount, confirm present items (a row is a big
tap-to-confirm target with an inline ± stepper for count drift), and explicitly **remove** or
**relocate** the ones that aren't there. **Completion is gated and two-tap:** a **"Yes to all
remaining"** button fills in the present items, and **"Done"** is a separate, deliberate press — you
can't complete a bin until every row is resolved, so nothing is ever silently omitted (and there is
**no delete-on-omit** in the session). Progress is durable (`verifiedAt`) so a reload, background, or
device switch resumes where you stood.

### Shipped so far

- **[#347] safety:** `bulkProcess` delete-missing is now a soft delete; `bulk-edit` refuses
  truncated/loading submits + warns. Regression test in
  `inventory-softdelete-guard.integration.test.ts`.
- **[#347] mobile nav:** `SessionLocationList` extracted; `MobileLocationSwitcher` (sticky chip →
  bottom Sheet) gives the phone "what's left / jump." QR scan-jump closes the sheet on success.
- **Quick wins (this pass):** confirmed-checks persist per root to localStorage and survive a reload
  / tree-invalidating mutation (re-keyed the init effect to the root, not `sessionLocations`);
  safe-area-aware action bar + page padding; barcode scanner stays open for a continuous sweep
  (deduped); mobile QR manual-code fallback inside the scan Sheet; undo moved to a bottom sonner
  snackbar; name-only `product.quickCreate` for "create new".

### Remaining work

- **Durable progress — `inventoryEntry.verifiedAt`.** Add a per-item, additive/nullable `verifiedAt`
  column (dev DB *is* prod Neon, so additive only). "Confirmed" becomes a durable fact; it also
  feeds data-quality. Prefer batching writes (e.g. at "Done") over a write per checkmark to respect
  the workerd frozen-clock / Neon-egress sensitivities in MEMORY. *Prerequisite for the reconcile.*
- **The reconcile — gated "Done".** "Done" is disabled until every expected row is resolved
  (confirmed / removed / relocated); a **"Yes to all remaining"** button one-taps the present items.
  Completion persists `verifiedAt` + an explicit per-item **remove** (soft-delete, undoable) +
  qty-adjust, records a summary, and is the *only* thing that stamps `lastBulkInventory` (stop the
  `bulkMove` side-effect stamp). **No delete-on-omit** — omission is impossible by construction.
- **Row reframe.** Whole row a tap-to-confirm target; inline ± stepper auto-saving for the integer-
  `each` case (keyboard only for weight/length); swipe-left → **Remove** / **Relocate**.
- **Scan-anything spot-check.** A default door that resolves *any* location (re-confirming its
  identity before any destructive action) and returns to "scan the next."
- **Data-quality + capture.** Badge duplicate-unique / no-product-link rows; promote photo→detect for
  unbarcoded hardware.

### Decisions (resolved)

- **Omitted items / reconcile:** gated "Done" + separate "Yes to all remaining" (two taps, never
  one) → **explicit-remove-only, no delete-on-omit** in the session. `bulk-edit` keeps delete-on-omit
  as the desktop power tool.
- **Unknown bucket:** keep as-is. "No → global Unknown" stays.
- **Durable progress:** per-item `inventoryEntry.verifiedAt` (not a separate session entity, not an
  offline queue).
- **Default unit:** pin to `each` with a toggle for weight/length items.
- **`/inventory/bulk-edit`:** keep it (now hardened) as the desktop power tool; demote its nav
  prominence rather than delete it.

### Deferred

- **Photo-as-identity** for unlabeled garage objects — addable as "photo + name later" without a
  Product at all. Worth doing, but a larger feature; revisit after the reconcile lands.
- **Offline optimistic queue** — not chosen; `verifiedAt` covers durable progress for now.

[#342]: https://github.com/nickysemenza/cubby/pull/342
[#347]: https://github.com/nickysemenza/cubby/pull/347
