# Production migrations

The GitHub production deployment applies pending committed migrations before
deploying the already-built Worker. A migration failure stops deployment. The
runner uses only `PRODUCTION_DIRECT_DATABASE_URL` for production; it never
falls back to `DATABASE_URL`. Ordinary migrations must work with the currently
deployed code. Verify preservation with synthetic predecessor data before merge,
then read back production data and schema after release. See the
[domain rules](../agents/domain-rules.md#production-changes) for preservation
requirements and [CI](../ci.md#deployment) for workflow execution and retries.
Do not run production migrations by hand while a Deploy run is queued or
running; Actions serialization does not cover operator shells.

## Staged and breaking cutovers

One exclusive operator owns a staged cutover, including Actions and local
applications. Before merging a journal containing an unsafe contraction, set
the `cloudflare` GitHub Environment variable `PRODUCTION_MIGRATION_THROUGH` to
the exact last compatible migration tag. Actions passes this inclusive boundary
to the existing runner, then deploys the matching code. Leave it set until the
operator applies and verifies the contraction after deployment; then delete the
variable before the next release. A boundary behind the applied database fails
closed. If no new migration is safe before deploy, use the last already-applied
tag. Never guess compatibility from a migration's name or SQL keywords.
From setting the boundary or applying an unmerged expansion until the staged
PR merges, admit no other `main` merge or Deploy retry: that revision lacks the
new journal tag and fails closed. Merge the staged PR next.

For a breaking cutover that cannot use this sequence, establish its documented
writer barrier and apply the authorized migrations manually before merge; the
deployment runner will verify that applied prefix. Keep the barrier until the
matching deployment and preservation readback succeed. No other release or
operator may overlap this cutover.

When the member explicitly authorizes a non-graceful cutover with writers
enabled, the normal Actions migration-before-deploy sequence may apply the
preserving contraction before the matching Worker deploys. Old requests and
Workflow attempts may fail during or after that cutover. Lock every retired
copy source and destination against writes before reading them, hold those
locks through the copy/drop commit, and refuse contraction unless all retained
content has a verified destination. Verify preservation and deployment after
release; do not overlap a manual schema application with Actions.

For an expand/contract rollout, choose the exact last expand tag from
`apps/web/drizzle/meta/_journal.json`, excluding the contract migration. Set
`PRODUCTION_MIGRATION_THROUGH` to that tag before merge, then let Actions apply
the expansion and deploy. To apply the same expansion manually before merge,
first ensure no Deploy run can overlap, then run:

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
preserved data. If expansion was manual, keep the environment boundary set
while merging and deploying the code that stops reading or writing the retired
shape. Only after that deployment finishes, apply through the chosen contract tag:

```sh
pnpm --filter @cubby/web db:migrate --target=production --through=EXACT_LAST_CONTRACT_TAG
```

Read back the transformed data and schema again, then delete the environment
boundary. A boundary does not identify
which SQL is compatible with the deployed code; the owner must review that
boundary before execution. Omitting `--through` retains the usual behavior of
applying every pending journal entry and is unsuitable for a staged rollout
whose journal already contains an undeployed contract.
