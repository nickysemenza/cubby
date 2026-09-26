# Run rename cutover

One big-bang window for the PR that renames `ImportRun` → `Run` (entity kind
`importRun` → `run`), anchors run findings, run mutations and AI usage/analysis
on `Entity`, drops the legacy meal `grams` columns, adds run attribution to
queued image processing, adds per-photo device-work state, and clears stale
nutrition totals on deleted recipes. Downtime is accepted; there is no dual
read path. Delete this runbook and its SQL once the cutover is verified.

Files: `scripts/cutovers/run-rename.sql` (one transaction, asserts its own
preconditions) and `scripts/cutovers/run-rename-verify.sql` (every row must
report zero).

1. **Prepare.** The PR is green, open without auto-merge, and up to date with
   `main`. Nobody else is pushing schema.
2. **Drain.** Wait until no run has `status = 'running'`
   (`SELECT count(*) FROM "ImportRun" WHERE status = 'running'`). Runs in
   `needs_review` are data and survive the rename. The SQL aborts if a run is
   still running.
3. **Back up.** Create a Neon branch of production named for the date.
4. **Rehearse.** Run `run-rename.sql` then `run-rename-verify.sql` against a
   second throwaway Neon branch; every verify row must be zero. Point a local
   `pnpm --dir apps/web exec drizzle-kit push --verbose` (answer no to every
   prompt) at that branch and confirm the only proposed changes are the known
   `gin_trgm_ops`/array-default drift. Delete the rehearsal branch.
5. **Cut over.** Run `run-rename.sql` against production, then merge the PR
   immediately. The previous deploy errors against the renamed tables until
   `deploy.yaml` finishes (a few minutes); queues retry.
6. **Verify.** Run `run-rename-verify.sql` against production. Confirm the
   deployed revision, load `/runs`, open a photo run and a purchase, save a
   meal, and list runs over MCP (`entity {action:"list", entity:"run"}`).
7. **Native.** Ship a TestFlight build from the merged commit the same day;
   older native builds cannot read the renamed operations.

Rollback: restore from the step-3 branch and redeploy the previous `main`
commit. There is no forward-compatible rollback of the rename itself.
