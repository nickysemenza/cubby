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
tables, operation receipts, preallocated entity IDs, or automatic mutation replay.

A minimal resource marker is stored before each write. Successful publication
or a known precommit refusal removes it. An uncertain outcome blocks that
resource (including the other Task collection and matching UID), while reads,
unrelated writes, and projection refresh remain available. In Settings →
Calendar state, inspect the record in Cubby before choosing **Clear uncertain
write**. Clearing only releases the marker; it does not repeat, undo, or delete
anything. Unknown creates can appear under a shortcode-based resource after
refresh if their client mapping was never saved; inspect for duplicates before
creating again.

Dirty notifications refresh promptly; the daily cron is the backstop. Refresh
publishes current entity state even with uncertain markers. Failed refreshes
retain the previous complete generation. Refresh cannot recover uncommitted
intent, lost mappings, duplicates, or arbitrary missed after-commit side effects.

DELETE is absent from the HTTP adapter's `METHODS` policy and advertised
privileges. A future PR must add its canonical implementation and decide how
to handle clients that omit `If-Match`; there is no environment switch.

## Validation

Focused parser and canonical write tests live in the existing suites. Run
`pnpm --filter @cubby/web test:calendar` manually for the small workerd/SQLite
smoke suite. It is not appended to normal tests, hooks, or hosted CI. Verify
Calendar.app on disposable data after protocol/setup changes.
