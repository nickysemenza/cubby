# Inventory Recount / Session Flow

> Status: shipped. The phone-first recount now has current-pass progress,
> explicit resume/start-over behavior, atomic reconciliation, staged
> relocation, scan-first spot-check entry, and a completion summary.

## 1. Purpose

Recount is Cubby's physical inventory reconciliation tool. You stand at a bin,
shelf, drawer, or room and compare what is physically present with what Cubby
expects there.

The primary environment is a one-handed iOS PWA walk through garage storage and
deep pantry locations. Most items are not barcoded; integer counts, photos, and
location labels matter more than grocery-style scanning.

Cubby is a personal, single-user app. The flow therefore favors speed and
recoverability over multi-user coordination. It is held to four rules:

1. The common case requires no per-item interaction; only exceptions are marked.
2. Finishing implicitly confirms every expected item that was not changed.
3. Expected-row changes commit atomically and reject an obviously stale tab.
4. Progress is resumable without accidentally reviving an old recount as a new
   one.

## 2. Starting a recount

`/inventory/session` leads with one action:

- **Scan a location** starts an immediate spot-check at that label.
- **Choose an area** reveals the location tree only when a broader sweep is
  needed.

Location detail pages link directly to the same route with `parentId`. A scan
from inside a recount jumps within the current subtree; an out-of-root scan
offers to switch to a new recount rooted at the scanned location.

Unknown is itself a valid root once it holds items — recounting it _is_ how you
drain it, by relocating each row to where it belongs. At that stop the pane
drops its own "From Unknown" tray and the "Move to Unknown" action, since both
would point at the bin you are standing in.

Progress is scoped to a specific pass, not to whether a location has ever been
audited. The local per-root record contains a version, `startedAt`/`updatedAt`,
current position, staged item resolutions, completed location ids, skipped
location ids, the session-location count, and the running summary. Reopening an
incomplete pass explicitly asks whether to resume it or start over. A finished
pass reopens on its summary screen and offers "Recount again."

The picker leads with an **In progress** block listing every unfinished pass
found in local storage — root name, X of Y settled, started/updated times, a
Resume button, and a dismiss ✕ that clears that pass. A stored root that no
longer resolves against the location tree is dropped on sight.

`lastBulkInventory` remains the durable historical audit timestamp. It is useful
as recency context, but it no longer defines the current pass's completed count
or incomplete filter.

## 3. Recounting one location

The review pane is ordered around the dominant task:

1. Confirm the location identity from its name, breadcrumb, and optional photo.
2. Review the expected inventory rows; untouched rows are presumed present.
3. Open **Change** for quantity, Move to Unknown, Move elsewhere, or Remove.
   Quantity takes either the ±1 stepper or a typed count (commits on blur or
   Enter, same floor of 1 — zero is the Remove action). A row that already has a
   staged change also offers a one-tap way back to assumed-present.
4. Open **Add something here** for manual/photo/barcode capture or to pull an
   item or nested location from Unknown.
5. Tap **Finish — rest are present (N)** once. If every row was already changed,
   the same action reads **Save recount**.

Unavailable Previous/Next controls are omitted, so a one-bin spot-check gives
the completion actions the full phone width.

### Skipping a location

Next to the save action, **Skip** defers a location that can't be reached right
now. Skipping is client-only — it never stamps `verifiedAt` or
`lastBulkInventory` — but it settles the location for pass progress, so one
unreachable bin can no longer strand the summary. Skipped stops keep their place
in the navigator with a muted `skipped` badge; opening one and saving it (or
tapping **Unskip**) puts it back in the pass, and the summary offers **Revisit
skipped locations** when any remain.

### Expected versus unexpected writes

- Expected-row verify, adjust, remove, and relocate decisions are staged and
  committed together by `inventory.reconcileSession`.
- Pulling from Unknown and capture actions are explicit immediate additions;
  their success toast makes that boundary visible, and the refreshed item is
  then included in the recount snapshot.
- Nested locations are not separately acknowledged during a recount. They appear
  as their own stops when they are part of the selected sweep.

## 3b. Sweeping a location

A **sweep** is the other half of the job and a separate surface: point a camera
at everything on a shelf. It is launchable from any location's own toolbar
("Sweep", beside Add item) and mounted inside the recount at its current stop.

It is deliberately not a recount. A recount reviews expected contents and its
stops require `directItemCount > 0`, so a brand-new empty shelf cannot be
targeted at all — which is exactly the thing most worth sweeping.

Each scan resolves server-side in `inventory.scanAtLocation`:

| Facts                    | Outcome                                           |
| ------------------------ | ------------------------------------------------- |
| No stock rows anywhere   | create a row here, stamped `verifiedAt`           |
| A stock row **here**     | confirm it — stamp `verifiedAt`, amount untouched |
| Stock rows **elsewhere** | write nothing; queue them for the end             |

**Confirm, never increment.** Sweeping a correct shelf twice must change
nothing. The intuitive alternative — "not a one-of-a-kind item, so add another"
— silently doubles a bookshelf on its first honest re-sweep, because products
created from an ISBN carry `expectedQuantity: null`, not `1`.

**Strays commit once, at the end.** Nothing interrupts the camera; the
`SweepStrayReview` panel collects everything found elsewhere and moves it in one
tap. Single-unit rows move whole; a row holding more than one unit asks
move-one-or-all, because a scan proves one object moved, not five. Curation of
newly created products is queued the same way rather than opening a modal per
scan.

`placement: "installed"` never counts as stock — a faucet plumbed into a wall is
not a stray to pull onto a shelf.

Absence stays out of scope. A row that is never scanned is never touched; only
an explicit recount closes the world.

### Scanning a bin QR

`classifyScannedLocation` reads **tree position, not pass membership**: a bin
carried into another room is usually still inside the recount root, so
classifying by "is it a stop in this pass" would call it a jump and lose the
adopt case entirely. Four outcomes — already here, already inside, would-be
cycle, and adoptable — and all four hold the camera open so a rack of labels can
be swept in one go.

An adopted bin does **not** join the current pass: membership is frozen when the
scope is set, so the cursor cannot renumber underneath you. The toast says so
rather than letting the bin look lost.

## 4. Reconcile safety

`reconcileLocationSession` is an atomic transaction with a lightweight stale-tab
guard. The client sends:

- the audited location id;
- every inventory-entry id expected at load time;
- the query's load timestamp; and
- exactly one resolution per expected entry.

Inside the transaction the repository reads the complete live location. It
rejects the commit when the id set differs, a row was updated after the snapshot,
a resolution is missing/duplicated/foreign, or a relocation target is invalid.
Only a successful complete transaction stamps `lastBulkInventory`. The guard
does not take explicit row locks: that complexity is unnecessary for the app's
single-user model, while the transaction still prevents partial recount writes.

Resolution behavior:

- `verify` stamps `verifiedAt`;
- `adjust` writes the amount, valuation, and `verifiedAt`;
- `remove` soft-deletes the row and its embedding;
- `relocate` moves the full row, merging with a same-product destination row
  when necessary and cleaning up a collapsed source embedding.

Plain `bulkMove` never stamps `lastBulkInventory`.

## 5. Completion

After the final location saves, the workbench shows a pass summary with:

- locations saved;
- items confirmed;
- quantities adjusted;
- items relocated;
- items removed; and
- locations skipped.

The next actions are Revisit skipped locations (when any were skipped), Scan
another location, Recount this root again, or return to Inventory. The finished
state persists across reloads on the same device.

## 6. Implementation map and deferred work

Primary files:

- `InventorySessionWorkbench.tsx` — orchestration, staged diff, progress, summary
- `useSessionProgress.ts` — versioned per-root pass state, skips,
  resume/start-over, and the stored-pass enumeration the picker resumes from
- `ParentPicker.tsx` — root choice plus the In-progress resume list
- `LocationReviewPane.tsx` — phone review interaction and completion bar
- `SessionCaptureActions.tsx` — unexpected-item capture inside the Add sheet
- `server/services/scan-plan.ts` — the pure add/confirm/queue decision
- `server/services/scan-into-location.service.ts` — resolve, plan, execute
- `_components/inventory/location-sweep/` — the sweep UI, shared by the location
  page and the recount
- `SessionLocationList.tsx` — outstanding-first current-pass navigation
- `QrJumpButton.tsx` — scan-first start, in-session switching, and bin adoption
- `server/repo/inventory/bulk.ts` — atomic reconcile and staleness guard

Still deliberately deferred:

- cross-device pass state (current pass state is device-local; durable inventory
  writes and `verifiedAt` are server-side);
- a true offline mutation queue;
- inventory-entry-without-product photo identity (photo capture currently reuses
  the `misc:` product convention);
- per-row inline ± steppers on the expected-contents rows — deliberately not
  shipped: the phone row already carries a thumbnail, name, state, status glyph,
  and Change, and two more targets crush the name column. Quantity editing lives
  in the Change sheet, where the stepper and typed entry both fit.

The [local journey coverage map](agents/core-journey-e2e.md) links the recount
browser test and records the native scan and photo-input gaps.
