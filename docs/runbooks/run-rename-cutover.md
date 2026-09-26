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
2. **Drain.** Finish or cancel the runs you care about. Any run still
   `running` or paused is failed by the SQL (`failureCode = 'run_cutover'`)
   and can be restarted from its run page afterwards; `needs_review` runs are
   data and survive the rename. The SQL sets `lock_timeout = 10s`, so a
   competing transaction aborts the cutover instead of stretching it; re-run.
3. **Back up.** Note the UTC time just before running the SQL; Neon's
   point-in-time restore to that instant is the rollback point.
4. **Rehearse.** Push the pre-rename schema to a scratch Postgres, seed
   synthetic rows (a running run, a finding targeting its run, grams-only
   meal rows, an orphan `AiUsage` entity, a deleted recipe with cached
   totals), run `run-rename.sql` then `run-rename-verify.sql`, and confirm a
   dry-run `drizzle-kit push` of the new schema proposes only the known
   `gin_trgm_ops`/array-default/composite-FK drift.
5. **Cut over.** Run `run-rename.sql` against production, then merge the PR
   immediately. The previous deploy errors against the renamed tables until
   `deploy.yaml` finishes (a few minutes); queues retry.
6. **Verify.** Run `run-rename-verify.sql` against production. Confirm the
   deployed revision, load `/runs`, open a photo run and a purchase, save a
   meal, and list runs over MCP (`entity {action:"list", entity:"run"}`).
7. **Native.** Ship a TestFlight build from the merged commit the same day;
   older native builds cannot read the renamed operations.

Rollback: restore to the step-3 point in time and redeploy the previous `main`
commit. There is no forward-compatible rollback of the rename itself.
