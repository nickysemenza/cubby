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

## Product identifier consolidation

Migration `0054_product_identifier_sufficiency` must run before deploying the
code that removes the model quality check. It preserves retired model exception
records in the surviving Identifier exception's note; standalone model exceptions
remain stale until reviewed against the combined requirement. Existing external-ID
exceptions keep their fingerprint and accepted/stale state for unchanged evidence.

The migration holds a write barrier on `DataException` until consolidation and a
constraint rejecting the retired check both commit. This prevents concurrent
exception edits from losing evidence and prevents an old server from recreating
a check the new reader cannot decode. Old requests attempting to accept a Model
exception after cutover receive the raw constraint error and must refresh.

The exclusive migration owner verifies exception-note preservation and all
unrelated household data before pushing, applies through this exact tag, then
checks the constraint and schema afterward. Use the journal-aware runner:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=0054_product_identifier_sufficiency
```

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
