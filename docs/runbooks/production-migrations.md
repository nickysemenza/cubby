# Production migrations

One exclusive owner applies production migrations and verifies household data
and the resulting schema. The runner uses only `PRODUCTION_DIRECT_DATABASE_URL`
for production; it never falls back to `DATABASE_URL`. See the
[domain rules](../agents/domain-rules.md#production-changes) for the deployment
order and data-preservation requirements.

For an expand/contract rollout, choose the exact last expand tag from
`apps/web/drizzle/meta/_journal.json`, excluding the contract migration. Run:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=EXACT_LAST_EXPAND_TAG
```

Replace the placeholder with the complete journal tag, without `.sql`.
`--through` is inclusive: every pending predecessor runs, and no later entry
runs. Unknown tags, non-prefix or changed-hash bookkeeping, and unordered
journals refuse before any database write. A database already beyond the
requested tag also refuses without mutation; this command never rolls back
applied migrations. The runner has no dry-run mode.

Verify the applied bookkeeping ends at the expand boundary and read back the
preserved data. Deploy the code that stops reading or writing the retired
shape. Only after that deployment, apply through the chosen contract tag:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=EXACT_LAST_CONTRACT_TAG
```

Read back the transformed data and schema again. A boundary does not identify
which SQL is compatible with the deployed code; the owner must review that
boundary before execution. Omitting `--through` retains the usual behavior of
applying every pending journal entry and is unsuitable for a staged rollout
whose journal already contains an undeployed contract.

## Image job entity cutover

`0061_image_job_entity`, `0062_image_job_drop_public_id` and `0063_derived_ddl`
are one authorized breaking cutover, applied in one invocation; `0061` is not a
compatible expansion boundary. After commit, deployed code that inserts an
`ImageProcessingJob` without a shortcode, or reads `publicId`, fails until the
matching server and Worker deploy.

Quiesce image work first and keep it quiesced until the matching code is
verified:

1. Set `MAINTENANCE_MODE` (web Worker answers 503; cron skips).
2. `wrangler queues pause-delivery cubby-image-cloud` and
   `wrangler queues pause-delivery cubby-background`; maintenance mode does not
   gate queue consumers.
3. Wait for leased jobs to settle or expire (`ImageProcessingJob.state =
   'leased'`); the Apple companion cannot pull while the Worker answers 503.

Capture before/after fingerprints: job count by `state` and `kind`, the
retained job columns (UUID, image, run, state, attempt and lease fields,
result), and row counts of `ImageProcessingAttempt`, `ImageProcessingEvent`,
`ImageProcessingSubmissionJob`, `AiAnalysis` and `AiUsage`. Then apply:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=0063_derived_ddl
```

Read back: unchanged fingerprints; every job has a unique `IPR-` shortcode with
one `Entity` row of kind `imageJob`; `publicId` is gone; the identity FK and
the `Entity_identity_*` triggers exist on `ImageProcessingJob`; the journal ends
at `0063_derived_ddl`. The migration takes `ACCESS EXCLUSIVE` on
`ImageProcessingJob` for the whole backfill and on `Entity` only from its
constraint widening to commit (blocking every entity insert for that window);
`0063` recreates the identity triggers. On failure the whole batch rolls back:
verify bookkeeping is unchanged before retrying. After a successful commit,
keep maintenance on and roll forward if the deploy fails. Then merge, verify
the deployed server, resume queue delivery, delete `MAINTENANCE_MODE`, and
expect older native builds to receive 426 until they update to the bumped
compatibility version. Old long `IPR-` ids and `/runs/jobs/…` links stop
resolving by design.

## Label-review retirement

Deploy the code that removes Product label-review fields and filters retired
exception records before applying `0055_remove_label_review` and
`0056_retire_label_review_metadata`. This contraction removes only the review
marker and retired-check exceptions; identity exceptions lose their label-photo
revision while retaining their observed values and notes. Verify Product notes,
Image and EntityAttachment rows, EntitySource evidence, and InventoryEntry amounts
are preserved, then confirm the retired column and exception records are gone.

## Durable member AI work

Provision `cubby-image-cloud` using the one-time commands in
[infrastructure](../infrastructure.md#workflow-backed-runs) before deploying its
producer binding. Keep the shared background queue's existing concurrency bound.
Apply through `0059_discovery-handling-receipts` before matching code deploys.
The expansion adds request receipts and execution metadata and widens Run values.
`0058_preserve-manual-ai-run-history` changes completed/failed and machine
budget-paused manual relevance Run purposes, plus persisted legacy Sweep pause statuses. Preview Runs,
Email decisions, stored inputs/progress, observations and financial rows survive.

Before and after application, compare aggregate household entity counts, signed
Expense totals and immutable Run input/progress evidence. Read back changed
purposes/statuses and the request-table/index/check catalog. Historical recovery
starts under matching code and current authorization; migration itself does not
rerun models or repair missing audit history. The populated predecessor
migration regression verifies these preservation boundaries with synthetic data.

## Photo import lifecycle

Apply through `0060_photo-import-lifecycle` before deploying photo import push
registration or proposal provenance writes. This expansion adds
`RunPushRegistration` and nullable `PhotoGroupProposal.origin`; existing Runs,
photo memberships, proposals, Products, inventory and financial records remain
unchanged. Preserve the immutable applied journal prefix through
`0059_discovery-handling-receipts` when integrating another branch.

Before and after application, compare retained row counts and fingerprints,
excluding only the newly added nullable origin column. Verify the exact applied
journal prefix and full catalog equality. Configure the APNs Worker secrets
listed in [infrastructure](../infrastructure.md#secrets-and-plaintext-variables) separately; schema
application does not establish signed-client or locked-device push delivery.

## Typed Source references

Apply expansion only through `0051_entity_source_targets`, then deploy the
matching server and refreshed clients. Let old in-flight writes finish before
applying `0052_normalize_entity_source_targets`: old Source merge deduplication
ignores the new target identity, and old target merges cannot repoint citations.
Do not apply both tags before deployment. Before and after normalization,
verify the Source row count and all quote, field, fingerprint, observation,
variant and recorder metadata are unchanged; only resolvable trusted internal
URLs should become typed identities. Read back target foreign keys and confirm
external and unresolved URLs survive. Normalization includes retained deleted
identities and redirects from merged codes.

## Email convergence cutover

This rollout uses one breaking migration. The member explicitly requests leaving
production services enabled: preserve existing queue/Workflow states and do not
set maintenance. Verify activity/backlog and capture financial/provenance baselines.
Idleness is only an observation; the migration locks retired Run tables before
copy/drop and holds those locks through commit. Existing timeouts refuse contention.
Old requests may fail on removed tables/columns during the authorized breaking
interval. Apply the migration, verify SQL preservation/catalog, then merge and
verify the matching server deployment:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=0035_email_import_cutover
```

After matching code deploys and old in-flight work finishes, run the transform.
For a standalone operator shell, initialize the imported application modules with
`DATABASE_URL` equal to the explicit `PRODUCTION_DIRECT_DATABASE_URL`,
`SKIP_ENV_VALIDATION=1`, and `R2_PUBLIC_URL=https://unused.example.invalid`.
The transform selects only the explicit direct URL, validates migration bookkeeping
and stored evidence, and never accesses object storage; these initialization values
are not production storage credentials.

```sh
pnpm --filter @cubby/web db:promote-historical-orders --target=production
pnpm --filter @cubby/web db:promote-historical-orders --target=production --apply
pnpm --filter @cubby/web db:promote-historical-orders --target=production --apply
```

The transformation requires bookkeeping exactly at that migration. It uses the
runtime validator and canonical JavaScript fingerprint, writes only immutable
observations and accepted references, and rolls back if ledger or stock rows change.
Do not promote before deployment: old surviving import paths can change checksums
without maintaining the new accepted reference. Record aggregate counts, investigate
every refusal, disclose unknown snapshots, verify accepted-reference consistency,
and confirm the second apply promotes zero. Never reconstruct unknown extractions
from current Expenses or Products. Verify data/schema and automated client delivery
before normal use. On migration failure, verify rollback/bookkeeping before retrying.

After deployment, recovery-only queue messages may include
`task.coordinatorRetireBefore` as a fixed ISO timestamp covering the settled Runs
to retire. Repeat that same cutoff until readback finds zero; do not enqueue
`maintenance.purchase-discovery` during this recovery. Ordinary recovery omits
the override and preserves the 24-hour conversation window. A legacy
account_sync Run whose stored `agentSessionId` is a bare session UUID retires
through the same pass: the coordinator erases it only when exactly one settled
Run of a retired purpose stores that exact name, and refuses otherwise without
touching storage. Investigate a refusal; never rewrite the stored identity or
stamp `retiredAt` by hand.

## Shared Assessments and Feedback

The reviewed cutover has these inclusive journal boundaries:

- Online expansion ends at `0068_shared_assessment_expansion`, which creates
  storage without copying reviews or changing legacy supersession triggers.
- `0069_shared_assessment_reconciliation` and `0070_derived_ddl` run only inside the enforced
  quiesced cutover barrier. Final reconciliation locks and transforms legacy
  reviews and retires their storage; final derived DDL establishes current
  supersession, identity-evidence invalidation and retained order-event lifecycle.

Check these exact tags against the final PR journal before execution. Never
include reconciliation or derived DDL in online expansion. Reconcile legacy
Suggestions before replacing their supersession triggers; raw field changes
between expansion and cutover must still retire the legacy pending rows.

Before pushing or applying the cutover, prove preservation from a populated
predecessor database and capture a private production baseline. Compare origin
coverage and original keys for every retired store, including inactive image
confirmations, all field statuses and receipts, pair/group suppression scopes,
Email member labels and order-event decisions, frozen evaluation membership and
grades. Preserve order-event link authority when its Email is absent; deleting
an Email repoints that authority to the retained event, while deleting or
superseding the event retires its current projection. Missing historical
provenance remains unknown. Compare authoritative
current projections independently of historical row counts.

An initial online expansion/copy is not the final preservation boundary.
Before final reconciliation, establish an enforced maintenance barrier for
relevant server, device and background writers. Disabling initiation alone does
not stop existing requests or durable jobs: drain/cancel old in-flight work and
transform persisted targets and Run payloads referencing retired contracts.
The owner must be able to account for every admitted old writer before copying.

Hold source-table locks through the final reconciliation transaction and verify
updates made since an initial copy were retained. Keep the maintenance barrier
in place across deploying the matching server, retiring old references/FKs and
refreshing native/HTTP/MCP clients. The approved one-household wire break allows
old clients to refuse and reconnect; it does not allow an acknowledged old write
to disappear. Do not use observed idleness as proof of the barrier.

Read back exact source-origin coverage, field status/receipt preservation,
confirmed descriptions, operational Email authority, frozen weighted evaluation
metadata and exact suppression keys before contraction. Check lifecycle edges
and hard-delete constraints as well as table counts. Retire storage only after
all current readers and writers have moved; immutable review history remains on
durable subject identities. After contraction, verify the catalog and exercise
field review, Email review, image confirmation and a pairwise Product review
before reenabling automatic work. Inventory and ledger amounts must be unchanged.

Preservation evidence is private operator material outside the repository; the
public PR uses synthetic examples and reports checks and limits only.
