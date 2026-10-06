# Inventory Recount, Sweep, and Reconcile

> Status: shipped in the native app. The web UI for scanning, recount, sweep,
> and the location photo pass was retired; the server contract below is what the
> app calls.

## 1. Purpose

Recount is Cubby's physical inventory reconciliation tool. You stand at a bin,
shelf, drawer, or room and compare what is physically present with what Cubby
expects there. The native app ([native design](../apps/apple/DESIGN.md)) owns the
phone-first walk: scan, recount/audit, sweep, and the location photo pass.

Cubby is a personal, single-user app. The flow favors speed and recoverability
over multi-user coordination, under four rules:

1. The common case requires no per-item interaction; only exceptions are marked.
2. Finishing implicitly confirms every expected item that was not changed.
3. Expected-row changes commit atomically and reject an obviously stale snapshot.
4. Progress is resumable without accidentally reviving an old recount as a new
   one. Pass state is device-local; durable inventory writes and `verifiedAt` are
   server-side. `lastBulkInventory` is the historical audit timestamp, not the
   definition of the current pass.

## 2. Sweeping a location

A **sweep** points a camera at everything on a shelf. It is deliberately not a
recount: a recount reviews expected contents, so a brand-new empty shelf cannot
be recounted — which is exactly the thing most worth sweeping.

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

**Strays commit once, at the end.** Nothing interrupts the camera; the client
collects everything found elsewhere and commits it through
`inventory.resolveScanStrays`. Single-unit rows move whole; a row holding more
than one unit needs an explicit move-one-or-all choice, because a scan proves one
object moved, not five.

`placement: "installed"` never counts as stock — a faucet plumbed into a wall is
not a stray to pull onto a shelf. Absence stays out of scope: a row that is
never scanned is never touched; only an explicit recount closes the world.

## 3. Reconcile safety

`reconcileLocationSession` (`inventory.reconcileSession`) is an atomic
transaction with a lightweight stale-snapshot guard. The client sends:

- the audited location id;
- every inventory-entry id expected at load time;
- the snapshot token from `inventory.locationSnapshot`; and
- exactly one resolution per expected entry.

Inside the transaction the repository reads the complete live location. It
rejects the commit when the id set differs, a row was updated after the snapshot,
a resolution is missing/duplicated/foreign, or a relocation target is invalid.
Only a successful complete transaction stamps `lastBulkInventory`. The guard
does not take explicit row locks: that complexity is unnecessary for the app's
single-user model, while the transaction still prevents partial recount writes.

Resolution behavior:

- `verify` stamps `verifiedAt`;
- `adjust` writes the amount and `verifiedAt` (valuation is computed on read);
- `remove` soft-deletes the row and its embedding;
- `relocate` moves the full row, merging with a same-product destination row
  when necessary and cleaning up a collapsed source embedding.

Plain `bulkMove` never stamps `lastBulkInventory`. Skipping a location is
client-only: it never stamps `verifiedAt` or `lastBulkInventory`.

## 4. Implementation map

- `server/services/scan-plan.ts` — the pure add/confirm/queue decision
- `server/services/scan-into-location.service.ts` — resolve, plan, execute
- `server/repo/inventory/bulk.ts` — atomic reconcile and staleness guard
- `tests/e2e/native-fieldwork-api.spec.ts` — HTTP-level checks of the staged
  photo capture, confirm-never-increment, and reconcile staleness contracts

## 5. Retired web surfaces

The web app no longer scans, recounts, sweeps, or runs the location photo pass,
and it is no longer installable as a PWA. The old routes return the ordinary
404:

| Old URL                                        | Now |
| ---------------------------------------------- | --- |
| `/scan`                                        | 404 |
| `/inventory/session` (any `parent`/`worklist`) | 404 |
| `/locations/photo-pass` (any `parent`)         | 404 |

Printed QR label URLs (`/<shortcode>`) still open the record.

Still deliberately deferred: cross-device pass state, a true offline mutation
queue, and inventory-entry-without-product photo identity (photo capture reuses
the `misc:` product convention).
