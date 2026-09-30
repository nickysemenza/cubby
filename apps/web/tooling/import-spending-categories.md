# Reviewed legacy spending categories

Older CSV imports retained their provider category as `sourceCategory` without creating household `SpendingCategory` records. This repair previews copying those existing classifications. It never infers receipt or Product policies.

Use a verified direct endpoint in `PRODUCTION_DIRECT_DATABASE_URL`, then run:

```sh
pnpm --dir apps/web exec tsx tooling/import-spending-categories.ts --target=production
```

The default is read-only and prints counts and a fingerprint, without source labels, identifiers or credentials. Review the imported taxonomy in Cubby before applying it. To use a curated taxonomy instead, create the categories first and classify manually; this repair does not invent mappings between different names.

After review, set `CATEGORY_ROLLOUT_ACTOR_USER_ID` to the authenticated initiating member and rerun with `--apply=<reviewed fingerprint>`. Apply refuses a changed preview and performs ordinary audited entity writes in one transaction. Exact names reuse a live category; duplicate names are refused. Explicit classifications are preserved. Purchases inherit only when every live, non-void allocated transaction supplies the same category; unresolved purchases stay unchanged. Expenses continue inheriting their Purchase's category. Receipt and Product policies remain `unknown` for new categories and can be reviewed using Jev suggestions.

For a disposable loopback database, use `--target=dev` with `CATEGORY_ROLLOUT_DEV_DATABASE_URL`. Neither mode reads ambient `DATABASE_URL` or `E2E_DATABASE_URL` as its target. The command owns and closes its dedicated connection.
