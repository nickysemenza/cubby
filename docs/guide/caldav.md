# Connect Calendar

Open **Connect Calendar** from Settings or the calendar page. Both open the
same setup dialog. Create a separate Calendar app password, then enter the
server address, username, and password in Calendar.app → Add Account → Other
CalDAV Account → Manual. Use HTTPS. Passwords are displayed once; replacing or
revoking one invalidates it on every connected device.

The account exposes **Cubby Tasks**, **Cubby Completed Tasks**, and **Cubby
Meals**. Create, rename, and reschedule records in Calendar. Delete records and
complete or reopen Tasks in Cubby. Creating in Completed Tasks creates a
completed Task. Meal times snap to the nearest household-local slot, with ties
choosing the earlier slot. All-day Meals are unslotted. Tasks become all-day
ranges; Calendar notes, locations, and alarms are discarded. Recurrence,
invitations, sharing, calendar creation, and cross-calendar moves are unsupported.

The secondary **Read-only subscriptions** section provides Everything, Meals,
and Tasks feeds. Their URL tokens are independent of the app password. These
retain the rolling subscription window; CalDAV includes all Meals and dated
Tasks. Everything does not include the in-app calendar's expenses/project spans.

## Storage and writes

All external calendar reads, including authentication and discovery, use the
Calendar Durable Object's SQLite storage. No cache miss opens PostgreSQL. Before
a publication exists the DO returns temporary unavailability.

PostgreSQL owns Tasks and Meals. The DO owns credentials and durable resource
identities. Cubby-created records use shortcode-based filenames and UIDs;
client-created records keep their UID and filename. Identity mappings survive
snapshot replacement, temporarily undated Tasks, completion/reopening, and
deletion. Resetting DO storage loses client identity metadata.

Creates and updates use the canonical entity kernel, auditing, search updates,
and normal after-commit side effects. Transactional comparison of projected
fields protects against stale edits. There are no PostgreSQL calendar metadata
tables, separate operation receipts, preallocated entity IDs, or automatic mutation replay.

A resource marker is stored before each write. Before PostgreSQL commits, it
retains the exact canonical audit receipt and record shortcode. The audit entry
and entity mutation commit together; projection refresh checks that exact receipt
before restoring the original client UID and filename and releasing the marker.
A missing receipt never authorizes mutation replay. Markers from before receipt
capture remain unresolved; a nearby audit timestamp or matching title is not
identity evidence. Conflicting durable identities remain unresolved as well.

Successful writes publish their own canonical CalDAV resource directly into
SQLite, atomically with its durable identity and marker removal. They do not
wait for a rebuild of unrelated collections or subscription feeds. Dirty
notifications refresh subscriptions through the existing alarm. Failures before
receipt capture release their marker: semantic changes cannot commit before that
proof is durable. An unchanged Task PUT needs no audit receipt. A missing
PostgreSQL binding or a failed dirty alarm creates no marker.

An uncertain outcome blocks only that resource (including the other Task
collection and matching UID). Reads, unrelated writes and projection refresh
remain available. In Settings → Calendar state, inspect the record in Cubby
before choosing **Clear uncertain write**. Clearing only releases the marker;
it does not repeat, undo, or delete anything. An unresolved legacy create can
appear under a shortcode-based resource if its client mapping was never saved;
inspect for duplicates before creating again.

Dirty notifications refresh promptly; the daily cron is the backstop. Refresh
publishes current entity state even with uncertain markers. Failed refreshes
retain the previous complete generation. Refresh reads the full CalDAV collection
in 500-record pages and stages rendered resources in SQLite. A full refresh switches
the visible generation only after staging completes; individual writes publish
their own resource and identity atomically.
After an isolate reset, a pending dirty notification re-arms a missing or expired
alarm; new dirty notifications also repair expired wake-ups. The retry
discards partial staging and starts again. New dirty notifications that arrive
during a refresh remain pending after that generation publishes.

Read-only subscription rendering hydrates at most 100 records of each feed kind
per page under a repeatable-read snapshot, using the same calendar item values
as the interactive calendar. It skips daily summaries and appends one event at
a time to size-limited serialized documents. Each event is serialized once per
page and its text shared by every feed that publishes it (`all` repeats Meals
and Tasks), and a document releases its parts as soon as it is joined, so a
rebuild retains roughly one copy of each event plus the finished bodies. The existing rolling window and
document byte limits still apply. Refresh cannot recover uncommitted intent,
lost mappings, duplicates, or arbitrary missed after-commit side effects.

DELETE is absent from the HTTP adapter's `METHODS` policy and advertised
privileges. A future PR must add its canonical implementation and decide how
to handle clients that omit `If-Match`; there is no environment switch.

## Validation

Focused parser and canonical write tests live in the existing suites. Run
`pnpm --filter @cubby/web test:calendar` manually for the small workerd/SQLite
smoke suite. It is not appended to normal tests, hooks, or hosted CI. Verify
Calendar.app on disposable data after protocol/setup changes.
