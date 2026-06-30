# Inventory Audit / Session Flow

> Status: shipped in [#342] (commit `2f4ff503`), and **partially built**. The recount UI exists; the
> reconcile it implies does not. Read [§5 Known rough edges](#5-known-rough-edges) before you trust
> a "complete" stamp, and [§6 Redesign direction](#6-redesign-direction) before you extend it.

This doc serves two readers:

- **The owner (Nicky)** — what the flow is for and how to actually run an audit on a phone. Jump to
  [§1 Purpose](#1-purpose) and [§4 How to use it](#4-how-to-use-it).
- **A future Claude agent** — what the pieces are, where the danger is, and which direction the
  redesign should go. Everything here cites `file:line` against the real code.

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
duplicate entries, mislocated items, entries with no product link, junk auto-named rows. The audit
is the cheapest moment to notice "wait, that's listed twice" because you're physically holding the
evidence.

Keep these four facts in mind, because the current implementation does not yet honor all of them:

1. **Phone-first, one-handed.** The hot path is thumb taps, not keyboard entry.
2. **Location-at-a-time**, with a "what's left / jump to next" overview.
3. **Recount that actually writes the fix** — a matching recount and a skipped one must not look
   identical in the database.
4. **Resumable.** A garage walk *will* background the app, lose signal, or get reloaded. Progress
   you collected has to survive that.

---

## 2. Concepts

### Session and root

A **session** is a recount pass over a **subtree** of the location tree. You pick a **root**
location (a garage, a room, a cabinet) and the session flattens its auditable descendants into an
ordered list you walk through. The root is carried in the URL as the `parentId` search param
(`inventory.session.tsx`). With no `parentId`, the route gates on **`ParentPicker`**
(`InventorySessionWorkbench.tsx:564-707`) to choose one.

> ℹ️ There **is** a per-location door: location detail / list pages render an "Inventory Session"
> button that links to `/inventory/session?parentId=<thisLocation>`
> (`location-detail.tsx:187`, `location-basic-info.tsx:83`, `locationlist.tsx:202`), bypassing
> `ParentPicker`. `flattenAuditableLocations` (`session-utils.ts:141-169`) includes the location
> *itself* at index 0 plus descendants, and the initial index is the first incomplete location else 0
> (`InventorySessionWorkbench.tsx:237-240`). So for a **leaf bin** this is effectively a single-bin
> spot-check — you land right on it. The rough edges (problem #6) are narrower than "no door": a
> **container** location opens its whole subtree (no "this node only" scope), an **already-complete**
> bin teleports you to the first incomplete descendant, and the **global-nav** entry still forces
> `ParentPicker`.

### Location tree, expected vs. found

The **`LocationWorkbenchSidebar`** (`InventorySessionWorkbench.tsx:718-816`) renders the filterable
tree of auditable descendants, with completion checkmarks and confirmed/total badges. The
**`LocationReviewPane`** (`817-1187`) is the per-location screen: the **expected** inventory rows
(what the DB thinks is here), child-location rows, the Unknown tray, and prev/next nav.

- **Expected** = inventory entries the DB has at this location.
- **Found** = what you confirm by checking rows off. Confirmation lives in a client-only
  `confirmedIds` `Set` (`InventorySessionWorkbench.tsx:227`) — **this is volatile**, see §2 *lastBulkInventory*
  and problem #3.
- **Unexpected** = items physically present but not in the expected set; you add them via barcode/QR
  scan or manual product search in **`SessionCaptureActions`** (`1607-1892`).

### The Unknown tray

Marking a row **"No"** (not here) calls `moveToUnknown`, which `bulkMove`s the entry into a
**parentless global "Unknown" location** (`InventorySessionWorkbench.tsx:376-385`). Unknown is
deliberately **excluded** from session roots and auditable descendants
(`session-utils.ts:31-33,48` via `isGlobalUnknownLocation`), so **no flow ever drains it**. It is a
limbo bucket that only grows. Critically, the dominant real-world outcome — "it's gone / used up" —
has **no verb**: you can only *relocate to Unknown*, never *remove*. See problem #5.

### `lastBulkInventory`

`location.lastBulkInventory` (`schema.ts:541`) is the **only persisted signal** that a location was
audited. "Mark complete" calls `touchLastBulkInventory` (`location.ts:170`), which just stamps it to
`now()`. Two traps:

1. It is a **bare timestamp** — it records *that* you visited, never *what changed*.
2. It is **also stamped as a side effect of any `bulkMove`** (`bulk.ts:546-555`). So relocating a
   single item marks the source location "audited" with zero recount. A bin reads "done" the instant
   one thing leaves it.

### The destructive `bulkProcess` reconcile (and its danger)

There **is** a real reconcile engine — `bulkProcessInventoryEntries` (`bulk.ts:53-273`). Given a
location and a batch of entries, it **DELETES every existing entry not in the submitted batch**, then
creates/updates the rest. The delete is a **raw hard `tx.delete(inventoryEntry)`** (`bulk.ts:133-137`),
on a soft-delete model, with an audit `delete` entry but **no before-snapshot**.

Three things make this sharp:

- **It is a hard delete on a soft-delete codebase.** Per `CLAUDE.md`, every major entity uses
  `deletedAt` and "restore is intentionally not implemented." This one path violates that invariant —
  a deleted entry is *gone*, recovery is manual DB surgery.
- **It is behind the wrong door.** `bulkProcess` is imported **only** by the unrelated
  `/inventory/bulk-edit` route (`bulk-inventory-form.tsx:151`) — a desktop spreadsheet. **The session
  never calls it.** So the tool named like the audit cannot reconcile, and the engine that can is a
  separate surface entirely.
- **It loads truncated.** The bulk-edit form loads with `pageSize: 100` (`bulk-inventory-form.tsx:119`).
  A location with >100 entries loses everything past 100 on first save. A mid-refetch (non-`success`)
  load can wipe the location. No staleness guard means a stale tab deletes entries added since load.

> **Agent note:** if you wire `bulkProcess` into the session, you are pointing a hard-delete
> delete-on-omit diff at `confirmedIds` — the exact state problem #3 proves evaporates. Do **not** do
> this until progress is durable *and* the keep-set derives from server truth. See §6.

---

## 3. The flow today

1. **`/inventory/session`** → if no `parentId`, **`ParentPicker`** (`564-707`) to choose a root.
2. **`LocationWorkbenchSidebar`** (`718-816`) shows the filterable tree of auditable descendants;
   checkmarks mark completed locations. **This sidebar is `hidden lg:flex` (`748`)** — desktop only.
3. **`LocationReviewPane`** (`817-1187`) per location: expected inventory rows with checkoff, child
   rows, an **Unknown tray** (`UnknownTray`, `1424-1606`), and prev/next nav (`1158-1173`).
4. Per row (**`ExpectedItemReviewRow`**, `1188-1326`), a 2-col grid of Photo / Qty / Yes / No
   (`1283-1320`):
   - **Yes** → adds the id to `confirmedIds` (client `Set` only — **writes nothing to the DB**).
   - **Adjust qty** → opens an inline `AmountFieldGroup`, summons the keyboard, reflows the list,
     then "Save quantity" (`1253-1281`).
   - **No** → `moveToUnknown` → `bulkMove` into the global Unknown limbo.
   - **Add unexpected** → barcode/QR scan or manual product search (`SessionCaptureActions`,
     `1607-1892`); barcode/manual add hardcode `value: 1` each (`1749`, `1927`).
5. **Mark complete** → `touchLastBulkInventory` stamps `lastBulkInventory = now()`
   (`InventorySessionWorkbench.tsx:546-548`). **No reconcile happens.**
6. The **destructive `bulkProcess` reconcile** (`bulk.ts:53-273`) — the only engine that removes
   drifted entries — is **never reached from the session**. It lives solely in `/inventory/bulk-edit`.
7. **Undo** keeps the last 5 actions in a client `undoStack` (`UndoBar`, `2120-2146`).
   **`QrJumpButton`** (`2000-2119`) jumps to a location by scanning its shortcode QR, but rejects
   anything outside the chosen root (`isDescendantLocation`, `~2016`), and its manual-code fallback
   is `hidden lg:flex` (`2069`).

The blunt summary: **checking items off and marking a location complete produces no database
change.** A recount where everything matches is indistinguishable from one where you scrolled past
40 items. The only durable artifacts are `bulkMove`s (relocations) and the `lastBulkInventory`
stamp.

---

## 4. How to use it

> This reflects the flow **as it is today**, including its gaps. Where a step is a footgun, it's
> flagged.

### Running a real garage audit (subtree sweep)

1. **Do it on desktop, or accept blindness on the phone.** The "what's left / jump to a bin"
   sidebar is desktop-only. On a phone you only get prev/next chevrons and single-shot QR jumps — so
   either keep a laptop nearby for the map, or commit to a strict linear walk.
2. Open **`/inventory/session`** and pick the **root** = the broadest thing you're auditing today
   (e.g. "Garage"). The session flattens every auditable bin under it.
3. Walk the bins **in order**. In each: tap **Yes** on what's present, **adjust qty** when the count
   drifted, **No** on what's missing, and **add** anything unexpected (scan a barcode, or search the
   product).
4. **"No" sends the item to the global Unknown bucket — it does not delete it.** If the thing is
   actually *gone/used up*, there is currently no clean verb for that; you'll be draining Unknown by
   hand later (or via MCP / bulk-edit). Treat "No" as "relocate to limbo," not "remove."
5. **Mark complete** when the bin matches. Remember this only stamps a timestamp — it does **not**
   delete or persist your checkoffs. **Don't background the app mid-bin:** iOS will evict the tab and
   your green checkmarks and undo stack vanish (problem #3).
6. If you genuinely need the destructive delete-on-omit reconcile, that lives in
   **`/inventory/bulk-edit`** on desktop — and it is **dangerous** (hard delete, truncates at 100,
   no staleness guard). Eyeball the full list before saving and never use it on a >100-entry
   location.

### Quick spot-check (one bin)

The cleanest path today: open the **location's detail page** and hit **"Inventory Session"**
(`location-detail.tsx:187`). It roots the session at that location and, for a **leaf bin**, drops you
straight onto it — a real single-bin spot-check. Verify, adjust, mark complete, leave.

Caveats:

- If the location **has children**, you get its whole subtree as a multi-location session (you still
  land on the node itself first, as long as it isn't already marked complete).
- If the bin is **already marked complete**, the initial index skips to the first incomplete location
  in the subtree instead of staying on it.
- From the **global nav** (not the per-location button) you're forced through `ParentPicker` first.
- **QR jump** lands on a bin by scanning its shortcode, but only if it's *inside* the chosen root
  (`isDescendantLocation` rejects out-of-tree scans).

A scan-*anything*-to-start spot-check (resolve any bin, no root concept) is the remaining redesign
ask — see §6, *"Add scan-to-start spot-check as the default door."*

---

## 5. Known rough edges

Ranked by severity. These are the load-bearing problems a redesign must answer.

1. **The session never reconciles drift — its primary purpose is unimplemented.** "Mark complete"
   (`InventorySessionWorkbench.tsx:546-548`) only stamps `touchLastBulkInventory` (`location.ts:170`).
   Checking "Yes" writes nothing (`confirmedIds` is client `useState`, `227`). `bulkProcess` — the
   only engine that removes drifted entries — is never imported by the session. And
   `lastBulkInventory` is stamped as a side effect of any `bulkMove`, so a bin reads "audited" the
   instant one item is relocated, with zero recount.

2. **No phone experience for the task that happens on a phone.** The location list / progress /
   filter / jump sidebar is `hidden lg:flex` (`748`) with **no** mobile replacement. On a 380px
   garage walk you cannot see which of N bins are done, jump to the next incomplete one, or skip
   empties — only blind prev/next chevrons (`1158-1173`) and single-shot QR. "Show me what's left and
   let me jump" — the single most useful recount affordance — is invisible on the exact device the
   task occurs on.

3. **Session progress is volatile client state that silently evaporates.** `confirmedIds` and
   `undoStack` are `useState` (`227-230`); the effect at `232-242` resets `confirmedIds` on every
   `sessionLocations` identity change — and `invalidateSession` (`283-298`) invalidates
   location/inventory queries after every move/qty edit, so confirmed checkmarks vanish **mid-location
   the moment you mark one item missing.** iOS Safari also evicts backgrounded PWA tabs, dropping
   everything but the binary `lastBulkInventory` stamp. The checkoff UX implies durable progress the
   system does not keep.

4. **The destructive reconcile that exists is unsafe and behind the wrong door.** `bulkProcess`
   hard-`tx.delete`s (`bulk.ts:133-137`) every existing entry not in the submitted batch — on a
   soft-delete model — with no diff, no confirm, and a truncated `pageSize: 100` load
   (`bulk-inventory-form.tsx:119`). A >100-entry location loses everything past 100 on first save; a
   mid-refetch load wipes the location; no staleness guard means a stale snapshot deletes entries
   added since load. Because it's a hard delete, the soft-delete "retained / recoverable" invariant
   does **not** hold.

5. **"Missing" is conflated with "move to a global Unknown limbo" that nothing drains.** "No" →
   `moveToUnknown` → `bulkMove` into a parentless global Unknown (`376-385`). Unknown is excluded from
   session roots and auditable descendants (`session-utils.ts:31-33,48`), so no flow reconciles it.
   The dominant real outcome — "it's gone/used up" — has no verb. Drift is *moved*, not *fixed*;
   Unknown becomes a junk drawer that keeps inflating counts and valuation.

6. **Spot-check works for a leaf bin but degrades for containers and completed bins.** The
   per-location "Inventory Session" button (`location-detail.tsx:187`) roots a session at that
   location and lands you on it — fine for a leaf bin. But a **container** location opens its whole
   subtree (no "this node only" scope), and if the bin is **already marked complete** the initial
   index (`237-240`) skips to the first incomplete descendant instead of staying put. The
   **global-nav** entry still forces `ParentPicker` (`564-707`), and QR jump rejects anything outside
   the chosen root (`~2016`) — so there's no scan-*anything*-to-audit-this-bin mode.

7. **The core recount gesture is slow, crowded, and dangerous.** Each row is a 2-col grid of
   Photo/Qty/Yes/No (`1283-1320`) with the destructive **No** (a server move) one thumb-slip from
   **Yes**; no tap-row-to-confirm, no swipe, no "confirm all remaining." Counting drift requires
   opening an inline `AmountFieldGroup` that summons the keyboard and reflows the list (`1253-1281`).
   Barcode/manual add hardcode `value: 1` each (`1749`, `1927`). The hot path costs maximal taps and
   thumb travel one-handed, with the irreversible action adjacent to the safe one.

8. **The data-quality goal is essentially unbuilt, and capture is mis-prioritized for garage stuff.**
   The session surfaces no duplicate/mislocation/missing-link flags even though `findDuplicateUniqueProducts`
   exists and is wired only to a different surface (`inventory.ts:196`). Capture leads with a
   food-shaped manual-add combobox whose "create new" opens the full `ProductForm` (manufacturer
   required); Photo→Detect — the best path for unbarcoded hardware, with an already-garage-tuned
   prompt — is the disabled third button; barcode silently no-ops or commits "Product `<upc>`" junk.

---

## 6. Redesign direction

### North star

The audit is a **phone-first, scan-to-start, location-at-a-time recount** where the dominant gesture
is forgiving and the destructive ones are deliberate, and where **"I walked this bin" is a durable,
resumable fact** — not a volatile checkbox.

You stand in front of a shelf, scan its QR, and land directly on that one location's recount: a lean
list of expected contents, each row a **big tap-to-confirm target** with an inline **minus/plus
stepper** for count drift, and a **swipe-left** that reveals "Not here" → the one question that
matters: **relocate** (scan the real bin) or **remove** (soft-delete, undoable). A persistent bottom
**Add** opens a continuous camera (barcode-stream or shelf-detect) that appends items without
re-acquiring the camera each scan; quick-naming an unbarcoded bracket is one tap, no modal.

A sticky header chip (**"Garage · Bin 7 of 23 · 12 done"**) opens a bottom **Sheet** that *is* the old
desktop sidebar — same incomplete/empty filter, same confirmed/total badges — so "what's left" and
random-access jump finally exist on the phone. **"Done with this bin" is the meaning of reconcile**:
it submits the resolved set as one audited diff with a "removed N / moved N / adjusted N" summary you
can undo, and **only that** stamps `lastBulkInventory`.

One mode, **two front doors** sharing a core: **scan a bin** (spot-check, the default) and **walk a
subtree** (the planned sweep; `ParentPicker` demoted to that second door). Progress lives
**server-side**, keyed to the location, so a backgrounded PWA, a reload, or a device switch resumes
exactly where you stood. Data-quality is **woven into the same surface**, not a separate pass.

### Shipped so far

- ✅ **P2 safety fixes** (2026-06-29): `bulkProcess`'s delete-on-omit branch now **soft-deletes**
  (`bulk.ts` — set `deletedAt`, scoped to the delete-missing branch only; `bulkMove`'s source
  collapse intentionally stays a hard delete). `bulk-edit` now **refuses to submit on a truncated or
  still-loading snapshot** and shows a warning banner when the location holds more entries than one
  page (`bulk-inventory-form.tsx`). Regression test:
  `inventory-softdelete-guard.integration.test.ts` ("soft-deletes (not hard-deletes) omitted
  entries"). The staleness-vs-concurrent-write guard is still TODO.
- ✅ **P3 mobile location switcher** (2026-06-29): the sidebar body is extracted to a shared
  `SessionLocationList`; mobile (`<lg`) now gets a sticky header chip ("parent · bin X / N · done")
  that opens it in a bottom `Sheet` (`InventorySessionWorkbench.tsx`).

### Ranked proposals

The order below **folds in the adversarial critique's reprioritization**: durable progress is a
**hard prerequisite** for any delete-on-omit reconcile, and the cheap safety fixes ship first and
independently. Effort: S/M/L. Risk reflects blast radius on real inventory.

**P1 — Durable per-bin progress, server-side, derived from truth (prerequisite, do first).** *(M,
medium)*
Make "audited" a durable per-location fact, not client `useState`. The cheapest *correct* unit is a
**per-location resumable snapshot written once at "Done with bin"** — not a per-item `verifiedAt`
write on every checkmark (that multiplies chatty writes on the frozen-clock workerd path and trips
the Neon-egress sensitivity documented in MEMORY). Stop resetting `confirmedIds` in the
`sessionLocations` effect (`241`); derive confirmation from durable state so a tree invalidation
(`283-298`) and an iOS reload no longer wipe it. **localStorage is acceptable only for resuming
navigation/checkmark UX — never as the source of truth for a destructive submit.** *Addresses #1, #3.*
*Until this lands and the keep-set derives from server truth, no diff-reconcile may ship.*

**P2 — Ship the three safety quick-wins against the existing `bulk-edit` now, independently.** *(S,
low)* These de-risk the one destructive surface that ships *today*, regardless of the larger
redesign. Highest value-to-risk ratio in the doc:
- Change `bulk.ts:133-137` from raw `tx.delete` to a **soft delete** (set `deletedAt`) **on the
  delete-MISSING branch only**, and capture a before-snapshot in the audit `delete` entry.
  ⚠️ Do **not** apply this bulk-wide — `bulkMoveInventoryEntries` also `tx.delete`s to collapse a
  fully-moved source into a merged target (`bulk.ts:~411`); soft-deleting *that* leaves a zero-qty
  ghost that `notDeleted()` hides but audit/valuation/duplicate scans resurface.
- **Refuse to submit** a delete-missing batch when the loaded set is truncated
  (`items.length === pageSize`) or the `inventory.list` query is not in `success` state — closes the
  silent-wipe-on-partial-load hole.
- Add a **staleness guard** to the reconcile submit (reject if the snapshot is older than the latest
  server mutation for the location).
*Addresses #4.*

**P3 — Mobile location switcher: reuse the sidebar body in a bottom Sheet.** *(M, low)* Add a sticky
header chip ("Bin 7 of 23 · 12 done") that opens a `Sheet side="bottom"` rendering the **existing
`LocationWorkbenchSidebar` list** — same all/incomplete/empty filter (`738-771`), confirmed/total
badges (`800-807`), tap-to-jump (`783`). Extract the sidebar's `CardContent` body into one shared
component; desktop keeps it in the `lg` grid column, mobile mounts it in the Sheet. Pure additive UX,
no destructive machinery. *Addresses #2, #6.*

**P4 — Scan-to-start spot-check as the default door; demote `ParentPicker` to "plan a sweep".** *(M,
low)* QR/shortcode resolves **any** location (drop the `isDescendantLocation` gate `~2016` for
spot-check) and opens just that bin's recount; completing returns to "scan the next." Make the
empty-subtree dead-end (`481-495`) offer "pick a different root" / "add a bin" instead of a terminal
card. ⚠️ **Spot-check must NOT own a delete diff** unless it first re-confirms the resolved
location's identity (name/breadcrumb shown, explicit confirm) — otherwise a misscan teleports to and
reconciles the wrong tree. *Addresses #6.*

**P5 — Reframe the row: tap-to-confirm, inline stepper, swipe-to-"Not here".** *(L, medium)* Rework
`ExpectedItemReviewRow` (`1188-1326`): whole row a large tap target toggling confirmed; replace the
keyboard-summoning qty editor with **inline minus/plus steppers** auto-saving for the integer-`each`
case (reserve `AmountFieldGroup` behind an explicit "measure by weight/length"). Move the destructive
action into a **swipe-left** ("Not here") → two choices: **Relocate** (scan/pick real bin → `bulkMove`)
or **Remove** (soft-delete, undoable). Optionally prompt "found 2 of 3" via the partial-move
`bulkMove` already supported. *Addresses #5, #7.*

**P6 — The reconcile: "Done with this bin" — but the SAFE subset first.** *(split)* Keep the goal of
P-flagship (fold a reconcile into the session) but **gate the delete-on-omit half** behind P1 +
server-derived keep-set + identity re-confirm. **Until then, the session's reconcile is the safe
subset only:** explicit per-item **remove** (soft-delete, undoable) + qty-adjust + add. "Done with
bin" stamps `lastBulkInventory` (and **stop** stamping it as a `bulkMove` side effect, `bulk.ts:546-555`)
and records a summary, but does **not** delete-on-omit. This delivers ~80% of intent with ~10% of the
blast radius. *Addresses #1, partial #4/#5. The full delete-on-omit diff is the risky tail; defer it.*

**P7 — Weave in data-quality flags + fast garage capture (the cheap parts).** *(M now, L for the
rest)* Now: badge expected rows that are **duplicate-unique** (`findDuplicateUniqueProducts`,
`inventory.ts:196`) or have **no product link**. Make combobox "create new" call a name-only
quick-create (manufacturer defaults UNSPECIFIED) instead of opening the full `ProductForm`. Keep the
barcode scanner Sheet **open** after a read (drop `setScanner(null)` at `~1881`), flash+toast each
scan, debounce duplicate reads, close on explicit Done. **Defer** inline merge/relink and the
shelf-detect-as-primary rework. *Addresses #8.*

**P8 — Safe-area / bottom-nav ergonomics.** *(S, low)* Replace the hardcoded sticky `bottom-20`
(`1152`) / `pb-24` (`498`) with `bottom-[calc(3.5rem+env(safe-area-inset-bottom))]` (or a shared
`--bottom-nav-offset` token), and move undo from the top-sticky `UndoBar` (`2132`) to a transient
bottom Sonner snackbar in the thumb zone. Verify in standalone PWA on a notched device.

### Quick wins (ship piecemeal, low risk)

- **Soft-delete the delete-MISSING branch only** (`bulk.ts:133-137`) + before-snapshot in the audit
  entry — restores the soft-delete invariant for the one place that violates it, independent of the
  redesign. (Scope carefully — see P2's warning.)
- **Refuse-submit on truncation / non-`success`** in `bulk-inventory-form.tsx` — closes the silent
  wipe.
- **Safe-area bottom offset** (`1152`, `498`) so controls stop fighting the notch/tab bar.
- **Stop resetting `confirmedIds`** in the `sessionLocations` effect (`241`); key confirmation off
  inventory id and persist to localStorage by `parentId` so one qty edit's invalidation no longer
  wipes the green checkmarks. *(UX-resume only — never feed this to a destructive submit.)*
- **Keep the barcode Sheet open after a scan** (remove `setScanner(null)` at `~1881`); append +
  flash + toast, debounce dupes — turns single-shot scanning into a real shelf sweep.
- **Surface the QR manual-code fallback on mobile** (`2069`, currently `lg:flex`) as a "can't scan?
  enter code" field — the exact dim-garage failure case.
- **Name-only quick-create** for combobox "create new" so capturing an unbarcoded garage object is
  one tap.
- **Move undo to a bottom Sonner snackbar** (`2132`→) so mis-tap recovery doesn't require two
  full-page scrolls.

### Open questions for the owner

1. **Is "delete-on-omit reconcile" even the right primitive for a single-user tool?** A safer default
   is **additive confirm + explicit per-item remove** (what "No"→remove already approximates) with
   **no** bulk delete-of-omitted at all. The entire problem-#4 risk surface exists only because the
   design inherited the spreadsheet's delete-on-omit semantics. For one person walking bins,
   explicit-remove-only may eliminate the most dangerous operation entirely. **This is the
   highest-leverage decision in the doc** — answer it before building P6's delete half.
2. **Is the global Unknown bucket worth keeping?** If "Not here" offers relocate-or-remove inline,
   Unknown is only needed for "found it, don't know where it goes" — in which case it needs an
   end-of-session **"Resolve Unknown (N)"** drain step, not a silent dumping ground.
3. **Should "Mark complete" hard-require every row resolved** before stamping, or just warn?
   Hard-require is safer but turns a 30-item bin into a 30-tap gate; empty bins are free either way.
   This needs a clear **"confirm all remaining as present (no deletes)"** vs **"reconcile (deletes
   omitted)"** distinction — you can't have both tap-to-confirm-all and a careful delete diff without
   it.
4. **Durable "reviewed": per-item `inventoryEntry.verifiedAt`, or a per-session snapshot entity?**
   `verifiedAt` is cheaper and feeds data-quality; a session entity gives a clean end-of-session diff
   and multi-device resume. Schema **must stay additive/nullable** — dev DB *is* prod Neon.
5. **Offline.** The garage is exactly where wifi dies, and every mutation today is online-only and
   will error-toast mid-walk. Do we want an **optimistic local queue that flushes on reconnect**? It
   simultaneously fixes the dead-zone gap *and* is the natural substrate for durable resumable
   progress — arguably the one piece of infrastructure worth building over a bespoke session entity.
6. **Photo-as-identity for unlabeled garage objects.** The primary contents are non-barcoded
   hardware. Should an unknown shelf object be addable as **"photo + name later" without a Product at
   all** (the detect path's `item.isMisc` hint)? Forcing every bracket through a manufacturer-required
   `ProductForm` is the real friction.
7. **Default unit pinned to `each`** with a hidden unit field? Most garage stuff is counted, but some
   deep-pantry items are genuinely weight/length. The toggle's discoverability needs deciding so bulk
   consumables aren't mis-recorded as counts.
8. **Keep or delete `/inventory/bulk-edit`?** After the safety quick-wins land on it, it's no longer
   acute, and desktop keyboard bulk-editing is genuinely useful to a power user. Recommendation:
   **demote its nav entry** (`inventory-actions.tsx:33`, `quick-actions.ts:67`), **keep the tool** —
   don't spend effort deleting a working surface.

---

### Appendix: key files

| Area | Path |
| --- | --- |
| Route + `parentId` param | `apps/web/src/routes/_authenticated/inventory.session.tsx` |
| Secondary "bulk edit" door | `apps/web/src/routes/_authenticated/inventory.bulk-edit.tsx` → `BulkInventoryForm` |
| The whole experience (~2150 lines) | `apps/web/src/app/inventory/session/InventorySessionWorkbench.tsx` |
| Session helpers | `apps/web/src/app/inventory/session/session-utils.ts` |
| Reconcile + move engines | `apps/web/src/server/repo/inventory/bulk.ts` (`bulkProcess` 53-273, `bulkMove` 279+) |
| Routers | `apps/web/src/server/api/routers/inventory.ts` (148-193), `location.ts` (166-205) |
| Schema | `apps/web/src/server/db/schema.ts` (location ~532-579, `lastBulkInventory` 541) |
| Payload schemas | `packages/schemas/src/inventory.ts` (191-222), `location.ts` |

Sub-components inside `InventorySessionWorkbench.tsx`: `InventorySessionWorkbench` (193-562),
`ParentPicker` (564-707), `LocationWorkbenchSidebar` (718-816), `LocationReviewPane` (817-1187),
`ExpectedItemReviewRow` (1188-1326), `ExpectedLocationReviewRow` (1327-1423), `UnknownTray`
(1424-1606), `SessionCaptureActions` (1607-1892), `ManualAdd` (1920-1999), `QrJumpButton`
(2000-2119), `UndoBar` (2120-2146).

[#342]: https://github.com/nickysemenza/cubby/pull/342
