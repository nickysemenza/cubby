# Nutrition totals cutover

This release replaces the `Recipe.totals` JSON contract. It does not read or
write the old flattened fields. Coordinate the release before merging: main
automatically deploys the web Worker, which also consumes recomputation jobs.

1. Prepare the exact release commit and complete `pnpm verify:local:full`.
   Keep one owner for production deployment and the database reset.
2. Hold household app/API traffic and pause delivery on `cubby-background`.
   Allow already-running requests and recomputation jobs to finish before the
   reset. Keep the hold through deployment; old open clients must reload before
   returning to the app. Do not purge queued jobs.
3. Run `scripts/cutovers/nutrition-totals.sql` against the confirmed production
   database. Its verification result must be zero. The reset changes only the
   derived totals and their freshness timestamp, including on deleted recipes.
4. Deploy the verified web Worker release through the existing production
   deployment workflow. Confirm the deployed revision before releasing traffic
   or background delivery. A gradual split between old and new Worker versions
   is not supported for this cutover.
5. Resume background delivery and open Settings → Maintenance. Run the existing
   recompute-all operation. Recipes, meals, and portions show pending estimates
   while their source totals are missing; pending is never rendered as zero.
6. Verify the stale recipe count drains, inspect a regenerated recipe with known
   and missing nutrients, and check a meal and a confirmed portion. A recipe
   without source nutrition is validly unavailable after recomputation and does
   not need repeated retries. Confirm ingredient amounts and observed portion
   grams, dates, and confirmations remain unchanged.

If deployment must be rolled back, quiesce traffic and writers again, clear the
derived totals with the same SQL, deploy the previous Worker, and regenerate
using that version. Do not serve the new JSON payload through an older reader.

This runbook and reset script prepare the operation; changing the application
code does not itself clear or deploy production data.
