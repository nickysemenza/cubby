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

After matching code deploys and old in-flight work finishes, run the transform:

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
