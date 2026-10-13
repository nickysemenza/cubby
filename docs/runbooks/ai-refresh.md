# AI prompt refresh

The [entity contract](../entities.md) owns refresh eligibility, history and
acceptance semantics. `AI_REFRESH_ENABLED` controls admission; the existing
Gateway Durable Object detects its own compiled feature policy. Gateway coordination
applies to production paid inference independently.

## Rollout

1. One migration owner applies the additive AiEvaluation/provenance/receipt
   expansion using the [production migration procedure](production-migrations.md)
   before merge, then verifies retained household data and `db:check
   --against-production`. Legacy nullable provenance stays unknown; no historical
   row or applied value is backfilled with a guessed version.
2. Use the dedicated `cubby-testing` Gateway for live tools and integration
   development; verify its provider routes/managed credentials before rollout. Production uses
   `cubby`; subscription calls retain their existing transport. Cloudflare's
   [200 requests/60 seconds/gateway limit](https://developers.cloudflare.com/ai-gateway/reference/limits/)
   concerns Unified Billing managed credentials, not BYOK. The production
   coordinator conservatively admits 180 starts/60 seconds and four streams;
   refresh's two-target cap reserves room for interactive traffic.
3. Verify local/development work with synthetic repository examples before
   household activation: run `pnpm --dir apps/web eval:mail-prompts` through the
   testing Gateway, plus the durable refresh regressions for affected features,
   legacy work, repeated activation, no-proposal completion and member decisions
   during inference. No live source belongs in repository fixtures, reports or
   PR text.
4. Enable the Wrangler flag in a reviewed deployment. Requests and the five-minute
   cron nudge the production Gateway singleton. It checks its own
   deployment version in Durable Object storage before opening Neon once to
   compare the exact compiled feature manifest.
   A monotonically increasing Durable Object ownership epoch fences delayed
   old instances transactionally, including rollback. A changed policy atomically
   updates generations and creates one discovery Run;
   repeated nudges and interrupted handoffs reuse it. Code-only releases do not
   create another Run. Rollback compares exact policies, including older versions.
   No activation endpoint, credential or post-deploy action is required.

## Observe and recover

AiEvaluation is the durable per-target ledger: target/snapshot, dependency
stamps, unique work key, attempt token/Run epoch, deadlines, saved results,
outcome receipt and scrubbed error. Run progress reports completed, blocked and
failed counts. AiUsage/EmailClassificationObservation and Suggestion receipts
retain inference and actual business-write provenance.

Discovery advances durable cursors through at most 200 field targets and 400
eligible Emails per invocation; Email execution rosters still cap at 200.
A new policy resets the scan cursor and its discovery Workflow checkpoints
bounded pages until both independent streams finish. Cursor writes are fenced
by activation revision, so an old page cannot overwrite a newer reset.
The five-minute cron only nudges the Durable Object and never polls Neon while
the deployment version is already observed. An alarm verifies and retries an interrupted startup handoff; external
activation does not block interactive Gateway admission. Active
Workflows own inference deadlines and retries. Nightly maintenance and existing
app-open recovery reconcile stranded Runs and relevant evidence/option changes.
The singleton uses its own compiled manifest, never a caller-supplied version;
a request from an old Worker cannot reinstall that Worker's policy. Saved field results resume
without another inference. Missing evidence, missing authorization and genuine
ambiguity wait for a relevant fingerprint change; authorization changes create
fresh eligible work. Admission waits defer without consuming inference retries.
Cancelled Runs remain stopped. Exhausted failures require Run retry; replacement
evaluations retain the earlier failed rows and link their receipts.

Disable `AI_REFRESH_ENABLED` in a deployment to pause admission and
fence publication. Already applied values and immutable history survive disabling
or rollback. Do not delete the additive ledger/receipt columns during rollback.
A failed startup handoff retains its alarm and retries the same discovery Run;
nightly reconciliation is the additional backstop. Input-only changes can wait
until app-open recovery or nightly maintenance; they do not require idle database
polling.

Use existing Run cancel/retry controls for individual failures; investigate the
ledger and Run diagnostics before replaying exhausted work. Gateway leases and
rolling starts survive DO restarts; cancelled/finished streams release capacity,
and abandoned requests expire after the bounded deadline.

Discovery isolates preparation and launch failures per target or Run, emits a
scrubbed diagnostic, and advances its bounded cursor; the next cursor pass retries
preparation. Recovery spends its ten-Run budget on failed or unstarted Runs, oldest first;
healthy active instances cannot starve relaunches. Existing unfinished Runs launch
before new discovery. Workflow target
steps retry infrastructure failures twice with exponential backoff; an exhausted
instance records a failed Run for recovery. Nightly and app-open recovery also
reconcile instances quiet for 30 minutes. Imported or historical Email sources
retain the existing classification-refresh deferral and report a blocked outcome.
