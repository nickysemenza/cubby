# AI prompt refresh

The [entity contract](../entities.md) owns refresh eligibility, history and
acceptance semantics. `AI_REFRESH_ENABLED` starts false; merging does not enable
refresh. Gateway coordination applies to production paid inference independently.

## Rollout

1. One migration owner applies the additive AiEvaluation/provenance/receipt
   expansion using the [production migration procedure](production-migrations.md)
   before merge, then verifies retained household data and `db:check
   --against-production`. Legacy nullable provenance stays unknown; no historical
   row or applied value is backfilled with a guessed version.
2. Provision `cubby-evaluation` with the same required provider routes/managed
   credentials for live tools and integration development. Production uses
   `cubby`; subscription calls retain their existing transport. Cloudflare's
   [200 requests/60 seconds/gateway limit](https://developers.cloudflare.com/ai-gateway/reference/limits/)
   concerns Unified Billing managed credentials, not BYOK. The production
   coordinator conservatively admits 180 starts/60 seconds and four streams;
   refresh's two-target cap reserves room for interactive traffic.
3. Install a matching `AI_REFRESH_ACTIVATION_TOKEN` Worker secret and GitHub
   deployment secret (at least 32 characters), then enable the Wrangler flag in
   a reviewed deployment. The serialized deploy job authenticates to
   `/api/internal/ai-refresh/activate` using the build’s short release SHA after deploy.
   Repeated activation is idempotent; rollback changes affected generations.
   Activation compares the served build and queues the existing recovery task.
4. Start with synthetic staging work. Verify one affected feature, legacy work,
   repeated activation, no-proposal completion and member decisions during
   inference before enabling household refresh. No live source belongs in
   repository fixtures, reports or PR text.

## Observe and recover

AiEvaluation is the durable per-target ledger: target/snapshot, dependency
stamps, unique work key, attempt token/Run epoch, deadlines, saved results,
outcome receipt and scrubbed error. Run progress reports completed, blocked and
failed counts. AiUsage/EmailClassificationObservation and Suggestion receipts
retain inference and actual business-write provenance.

Discovery advances durable cursors through at most 200 field targets and 400
eligible Emails per invocation; Email execution rosters still cap at 200.
Five-minute cron and the existing app-open/durable timeout reconciliation resume
known unfinished work. Only the activation endpoint changes the manifest; stale
Worker cron cannot activate a different release. Saved field results resume
without another inference. Missing evidence, missing authorization and genuine
ambiguity wait for a relevant fingerprint change; authorization changes create
fresh eligible work. Admission waits defer without consuming inference retries.
Cancelled Runs remain stopped. Exhausted failures require Run retry; replacement
evaluations retain the earlier failed rows and link their receipts.

Disable `AI_REFRESH_ENABLED` and activate that deployment to pause admission and
fence publication. Already applied values and immutable history survive disabling
or rollback. Do not delete the additive ledger/receipt columns during rollback.
Use existing Run cancel/retry controls for individual failures; investigate the
ledger and Run diagnostics before replaying exhausted work. Gateway leases and
rolling starts survive DO restarts; cancelled/finished streams release capacity,
and abandoned requests expire after the bounded deadline.

Discovery isolates preparation and launch failures per target or Run, emits a
scrubbed diagnostic, and advances its bounded cursor; the next cursor pass retries
preparation. Existing unfinished Runs launch before new discovery. Workflow target
steps retry infrastructure failures twice with exponential backoff; an exhausted
instance records a failed Run for recovery. The five-minute recovery tick also
reconciles instances quiet for 30 minutes. Imported or historical Email sources
retain the existing classification-refresh deferral and report a blocked outcome.
