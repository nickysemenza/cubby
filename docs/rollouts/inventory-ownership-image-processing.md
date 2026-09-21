# Inventory ownership and image processing rollout

Existing inventory remains `inherit`. Account defaults start disabled. Image processing starts disabled and paused. This rollout never assigns historical owners, fabricates purchases, or consumes the example photographs from the design discussion.

## Database sequencing

One operator owns the schema change. Apply the additive columns/tables before deploying code that selects them. Inspect the production schema and existing index definitions before replacing the inventory uniqueness index. Do not use an unattended `db:push` against production.

Before enabling ownership-aware writes, deploy the server's complete-snapshot reconciliation checks and the new web/Apple callers. The inventory identity is product, location, placement, raw ownership mode, and explicit owner. Inherited effective ownership never changes a slot's identity. Legacy tokenless destructive reconciliation is refused where it could omit an ownership-distinguished row.

The widened unique index must be installed before partial ownership transfers are enabled. Check existing quantity units and duplicate raw slots first. No migration folds incompatible units or splits history into invented acquisitions.

Apply the ImageDerivative, ImageProcessingJob, ImageDescriptionCorrection, and ImageProcessingOrphan tables; add Image.useOriginal; extend AiAnalysis metadata and its semantic cache key. Preserve all old analysis rows and all originals. Verify constraints and foreign keys after application.

## Activation

1. Run generated-contract validation, focused unit and PostgreSQL regressions, browser checks, and native builds/tests.
2. Verify subject lifting on authorized fixtures on an actual Mac and foreground iPhone/iPad. Include rotated HEIC, no-subject, transparent PNG, disconnect/replay, and a late upload after deletion.
3. Compare cloud and Apple descriptions on the same authorized fixtures. Cloud remains preferred; capability absence is an unavailable result.
4. Resume queued work in Maintenance. Enable new-upload processing only after the fixture results are checked.
5. Start with a bounded backfill, check results and spend, then continue batches. Pausing stops new claims; in-flight attempts may finish.

No merge should proceed until CI passes on the exact final head. A successful build does not verify locked-device or actual-device behavior.

## Implementation validation

Local validation covers the full fast-test tier, `pnpm check`, `pnpm check:all` (including Worker tests), generated Swift bindings and formatting, all 495 PostgreSQL tests, including three explanation integration regressions. Database coverage includes ownership mutations/merges, complete snapshots, Collections, image jobs/search/cleanup, legacy AI import compatibility, the checked-in migration scripts, and real price/ownership/count traces with bounded evidence. Both macOS and iOS simulator applications build successfully. CubbyKit's 313 tests pass; real Mac Vision cases cover JPEG and HEIC orientation, transparent PNG output, original preservation, and no-subject behavior using synthetic fixtures.

The built-browser wardrobe, Collections, and recount scenarios pass, including phone-sized ownership quantities and an explicit ownership edit. Before activation, actual foreground iPhone/iPad processing, end-to-end device disconnect/replay, and cloud-versus-Apple description evaluation still require authorized sample runs. Exact-head hosted CI remains a merge gate. No production schema changes or sample-photo imports were performed during local implementation; processing remains disabled and paused.
