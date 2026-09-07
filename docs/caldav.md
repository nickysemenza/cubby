# Calendar.app access

Settings → **Set up Calendar app** creates a separate Calendar password. Copy
the server address, generated username, and password into Calendar.app → Add
Account → Other CalDAV Account → Manual. Use HTTPS. The password is displayed
once; replacing or revoking it invalidates the old password on every device.

The account contains three fixed editable calendars:

- **Cubby Tasks**: dated Tasks that are not completed.
- **Cubby Completed Tasks**: dated completed Tasks. Toggle this calendar to
  show or hide them. Complete or reopen Tasks in Cubby; creating directly in
  this calendar creates a completed Task.
- **Cubby Meals**: all Meals.

Calendar can create, rename, and reschedule these records. Deletion currently
requires an `If-Match` header: tested Calendar.app requests omit it and receive
`428`, so delete records in Cubby until that compatibility decision is resolved.
CalDAV clients that supply the condition can delete records, subject to Cubby's
normal deletion policies. Project membership, recipes, completion
status, and other unrelated fields remain controlled in Cubby. Moving events
between calendars, recurrence, invitations, sharing, and calendar creation are
not supported. Notes, locations, and alarms entered in Calendar are discarded.

Tasks use dates, so timed events become all-day date ranges. A one-day all-day
Meal is unslotted. Timed Meals snap to the nearest household-local slot:
09:00 breakfast, 11:00 brunch, 12:00 lunch, 15:00 snack, 19:00 dinner, or
20:00 dessert. Equal distances choose the earlier slot. Meals return as
30-minute events; multi-day or cross-midnight Meals are rejected.

Existing read-only subscription feeds remain available in the Calendar
subscription dialog. Their combined feed contains Tasks and Meals; it does
not publish the in-app calendar's expenses or project spans.

## Runtime and storage

All external calendar reads use the Calendar Durable Object's local SQLite
storage, including credential verification. No cache miss or read request
opens PostgreSQL. CalDAV requires the Cloudflare Worker runtime; the ordinary
Node development server cannot issue Calendar credentials.

Background refreshes publish all dated entities into a coherent SQL generation.
Subscription documents retain their existing rolling window. Dirty notifications
and the daily scheduled refresh reconcile changes made in Cubby. The Settings
inspector reports publication status and pending writes without returning
credentials or event bodies.

CalDAV writes pass through the canonical entity kernel and repositories. Their
PostgreSQL transaction persists resource identity and a write receipt. The DO
publishes the committed result before acknowledging success. An interrupted
operation remains in its SQL journal and is reconciled by its alarm; receipts
prevent repeated canonical mutations. Until recovery succeeds, reads continue
to serve the previous generation.

## Deployment and validation

This feature uses a clean calendar-storage cutover. The SQLite migration runs
on DO initialization and removes obsolete calendar-owned KV keys. Old
subscription URLs may stop working: generate replacement URLs after deployment.
Apply the additive PostgreSQL calendar identity/receipt schema before using the
new code. Calendar credentials trigger the initial background publication;
until it finishes CalDAV reports temporary unavailability.

Run `pnpm --filter @cubby/web test:calendar` for real workerd/SQLite protocol
tests, including an independent `tsdav` client. `pnpm --filter @cubby/web
test:calendar:postgres` exercises real DO-to-PostgreSQL CRUD and recovery after
a committed write fails publication, using a disposable IntegreSQL database.
Pure ICS tests use the normal `pnpm test:file` command. Canonical write contracts
require PostgreSQL. Run the
Cloudflare build and verify Calendar.app discovery and CRUD on disposable data
before claiming client compatibility.

The protocol uses [ical.js](https://github.com/mozilla-comm/ical.js),
[@xmldom/xmldom](https://github.com/xmldom/xmldom), and
[Drizzle's Durable SQLite driver](https://orm.drizzle.team/docs/get-started/do-existing).
The custom adapter deliberately implements a bounded CalDAV surface rather
than a general calendar server.
