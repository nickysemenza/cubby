# Label nutrition and image-processing rollout

Run these operations after the PR has deployed. PR creation does not authorize
merging or establish operational completion. The child-table declaration move
must produce no database migration or physical catalog change.

1. Confirm the deployed revision and Apple client minimum version 2.3. Read
   `maintenance.imageProcessing` and retain the settings and description/cutout
   counters in private operational evidence.
2. Enable automatic processing of new uploads through
   `maintenance.configureImageProcessing`, preserving the current `paused`
   value. On `/problems`, this is **Enable new upload processing**.
3. Separately resume processing with `{ "enabled": true, "paused": false }`.
   On `/problems`, this is **Resume queued work**. Enabling and resuming are
   separate settings; pausing blocks new claims, while running work can finish.
4. Submit one bounded description-only batch:

   ```json
   { "batchSize": 25, "kinds": ["describe_image"], "retryFailures": false }
   ```

   Use `maintenance.backfillImageProcessing`. The general **Process next 25
   images** button includes every job kind and is unsuitable for this pass.

5. Wait for the scheduled work to settle. Read the counters again and inspect
   immutable analyses and attempt history. Verify the cloud processor revision,
   server-derived source image, structured extraction, and absence of automatic
   Product nutrition writes. Review a label through the existing Product editor:
   Cancel must preserve nutrition; Save must retain measured values, explicit
   inference evidence, and source attribution.
6. Inspect failures before explicitly retrying one bounded batch with the same
   `kinds` and `batchSize`, changing only `retryFailures` to `true`. Verify its
   results before scheduling more work; do not loop without a stated bound.
7. Run `recipe.recomputeAllDurable` after deployment to refresh persisted totals
   under the new inference/applicability semantics. Its receipt counts enqueued
   recipes, not completed calculations. Wait for processing and verify that
   `maintenance.awaitingWork.staleRecipeTotals` settles, then inspect representative
   measured, inferred-zero, unknown, and opted-out totals. Meal-food nutrition is
   calculated from current sources on read; recipe totals require this refresh.

Record deployment, settings, backfill, retry, and totals completion separately.
Native package/simulator acceptance does not establish physical-device charging
window acceptance; verify that on a device with participation enabled, including
expiry, pause, cancellation, and sign-out cleanup.

Keep operational records private. Repository and PR evidence must use synthetic
examples and aggregate validation results without household records or entity IDs.
