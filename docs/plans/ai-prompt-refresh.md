# Targeted AI re-evaluation

Status: proposed implementation plan; design agreed in the planning session.
No implementation, migration, production query, deployment, or inference was
performed. Repository inspection date: 2026-10-13.

## Outcome and scope

A deployed change to an eligible feature refreshes its unresolved work:
uncertain, unresolved Emails and pending, unaccepted field suggestions. Applied
values, member Email resolutions/reviews, rejected suggestions, accepted source
associations, and prediction history survive. Confident settled Emails are
excluded by default. Unrelated features do not run.

Relevant evidence and option-meaning changes use the same invalidation path.
Unknown legacy provenance is evaluated once when eligible. Exact version changes,
including rollback, trigger refresh. Repeated deployment notifications do not.

The original sequential-refresh requirement was explicitly revised: start with
two independent targets in flight, with dependent stages and paired calls within
one target sequential. Interactive work remains independent. Email selection
and public reclassify inputs retain the existing maximum of 200.

Keep the existing confidence-based auto-application policy: only eligible blank
additions from the primary/pinned model at the existing threshold can apply;
corrections remain pending. Auto-application gains an explicit, atomic audit
receipt. Independent Luna/Sol grading may evaluate any historical prediction,
irrespective of acceptance status. Model grades and member labels remain distinct.

## Verified baseline

Paths below are relative to the repository root. These are code observations,
not assertions about private production rows or live Gateway configuration.

- `apps/web/src/server/ai/features.ts:104-110,209-223,515-541` is the version
  authority. All generic field targets use `field-suggestion`; operation names
  distinguish fields. `AI_FEATURES` is already a typed catalog. There is no
  deployed-version reconciliation contract in this registry.
- `apps/web/src/server/repo/ai-analysis.ts:88-106` and
  `apps/web/src/server/db/schema.ts:778-809` key cached analyses by entity,
  feature, model, prompt version, and input fingerprint. A version bump changes
  reads; it does not enumerate or regenerate pending Suggestions or Emails.
- `apps/web/src/server/ai/decision-model.ts:490-504` and `response-cache.ts`
  already version response-cache requests. That cache is a separate concern from
  refresh discovery, durable target outcomes, and publication.
- `packages/schemas/src/child-tables/run.ts:827-899` stores Suggestion model,
  Run, values, confidence, pairing, and pending/applied/rejected/superseded state.
  It has no producing feature/version, input signature, or acceptance mode.
- `apps/web/src/server/ai/usage.ts:24-58,85-135` and
  `ai/run-feature.ts:183-214` record best-effort call telemetry. Usage has feature,
  operation, model, Run, release, and Gateway identifiers, but no direct prompt
  version. `runs/ensure-run.ts:176-198` can group several calls/features in an
  actor/hour Run. Run/model/telemetry joins cannot reliably reconstruct each
  historical Suggestion's version. Telemetry is not a publication receipt.
- `packages/schemas/src/child-tables/email-observations.ts:44-119`,
  `packages/schemas/src/email-observations.ts:28-43`, and
  `purchase-import/gmail/observations.ts:105-164` retain immutable classifications
  with operation, model, prompt version, checksum, Run, and conflict. However,
  `gmail/ingest.ts:589-595,667-677` retains only the call associated with the final
  deciding stage. A fallback decision does not prove the upstream triage version
  or every prerequisite. Rule/legacy rows can have unknown versions.
- `repo/email-sql.ts:85-119` distinguishes current-checksum member evidence from
  automated predictions. `gmail/ingest.ts:159-203` reuses unchanged classification
  based on checksum and `MAILBOX_RESEARCH_VERSION`, rather than the feature
  prompt versions. Member resolution and accepted/imported evidence protections
  are implemented by `gmail/ingest.ts:215-243,303-361` and `admitted-source.ts`.
- `gmail/reclassify.ts` freezes owner/mailbox-specific Email selections and
  checksums, with the 200 limit from `packages/schemas/src/mailbox-research.ts`.
  Its 150-second request work-start budget can leave deferred receipts.
  `repo/run-reclassification-read.ts:15-99` exposes recovery evidence. Publication
  and the progress receipt are separate transactions; interrupted outcomes can
  be unknown. `docs/todos.md` explicitly retains background Reclassify as unfinished.
- `runs/suggestion-sweep.ts:173-217,280-463` implements paced resumable work and
  paired predictions. Supersession, inserts, auto-application, and progress are
  separate writes. A crash can cause partial replacement or duplicate same-Run
  work. Failures are marked processed, so it is not a transient retry ledger.
  An empty result still reaches supersession. The 300-target/minute default in
  `runs/paced-batch.ts` is not a shared Gateway rate budget.
- `runs/suggestion-sweep.ts:531-550` auto-applies primary blank additions at
  confidence >= 0.85. `repo/suggestion-review.ts:183-244` applies through ordinary
  audited entity mutations or the finance review writer. `repo/audit-log.ts:255-263`
  records the supplied actor's Run. The sweep passes its original context rather
  than explicitly binding that actor to the newly created sweep Run. Applied
  status alone does not identify automatic acceptance.
- `repo/suggestion-review.ts:245-374` transactionally accepts and applies a
  correction, but plain rejection's final update lacks a pending-state condition.
  New refresh publication must share the review transition protocol.
- `entity-kernel/entity-operations.ts:540-551` and `db/derived-ddl.ts:105-146`
  supersede pending Suggestions on relevant writes. They do not retain a generic
  refresh intent. Trigger-side supersession can remove a pending-only candidate
  before a later scanner sees it.
- `workflow-runs/{contract,launcher,lifecycle,control}.ts` already provides
  Run-backed Workflow attempts, launch failures, cancellation/retry, and recovery.
  The supported Run purpose is currently `mail_discovery`. The launcher selects
  that binding unconditionally; extending only the purpose list is insufficient.
- `background-tasks/{publish,consume,handle}.ts`, `services/catch-up.service.ts`,
  and `cf-server.ts:618-675` provide delivery, app-open catch-up, and daily recovery.
  `wrangler.jsonc:225-258` has background concurrency 2, bounded delivery retries,
  and a daily cron. Queue ordering is not a global inference or freshness fence.

### PR #1982 and deployment

[PR #1982](https://github.com/nickysemenza/cubby/pull/1982) was OPEN and unmerged
on the final inspection. Its inspected head was
`aa3b14454b8143479fffbac4115cf5f2ba5a6079`; Apple checks remained queued and the
optional live Email check was skipped. The earlier head's successful live check
does not verify this head. The PR includes local mail-prompt evaluation, prompt
changes, and synthetic Gateway CI work; it supplies useful validation tooling,
not deployed refresh machinery.

The latest completed [main deployment](https://github.com/nickysemenza/cubby/actions/runs/38439251425)
was successful for `0598e8bebf01c5cd483adc0665b1a03532cc3156`, also the inspected
checkout HEAD. `.github/workflows/deploy.yaml` deploys main pushes, so #1982 has
not deployed through that path. No live release probe or Cloudflare version
inventory was queried. Recheck the PR head and successful deployed release before
implementation; do not assume this planning snapshot remains current.

## Recommended design

### One evaluation ledger, one version authority

Extend the existing declaration/runtime spine. Do not introduce a second prompt
registry, separate feature-specific job tables, or a new review queue.

Add `AiEvaluation` as a declared Run child in `child-tables/run.ts`. It is the
durable logical target record and provenance anchor, including outcomes with no
Suggestion. Each record stores:

- `runId`, unique `workKey`, target entity/record/optional field, and role
  (`primary` or paired).
- Logical producing feature, direct prompt version, and typed dependency stamps:
  every feature/version and routing policy that actually contributed. A selection
  overflow records both its logical parent and actual overflow feature. Email
  fallback records triage plus relevance dependencies, not just the last call.
- Input and option/evidence fingerprints, expected target state, original
  pending Suggestion references, immutable evidence references or bounded field
  basis/option snapshots needed to explain the result, and actual answering model.
- Active feature-generation stamps, Run attempt, attempt token/count,
  `nextAttemptAt`, execution deadline, typed result, terminal outcome, diagnostics,
  and publication receipt. Distinguish queued/running/result-ready/retry-wait,
  completed, blocked, failed, obsolete, and cancelled.

All persisted JSON and boundary contracts originate in Zod. Terminal prediction,
basis, provenance, and receipt data cannot be rewritten by later retries. An
operator restart after a terminal failure creates a new linked evaluation, not a
rewrite of history. Before each actual retry, increment the durable attempt
counter. Usage remains per-call telemetry rather than the ledger's authority.

Add `evaluationId` to Suggestion and EmailClassificationObservation. Their existing
model/version/history fields remain; do not restamp historical predictions with
the current registry version. Index evaluation target/recency, runnable state and
next-attempt time, and feature dependency membership. Index planning must follow
the actual candidate queries; start with bounded household scans rather than
building an inverted dependency subsystem unnecessarily.

Store the active deployed manifest and changed-feature generation numbers in one
typed infrastructure-owned `AppSettings` metadata row, using the existing
compare-and-swap pattern. Update only that row/key. Numeric generations are
activation fences, not prompt versions. Per-feature generations prevent an
unrelated deployment from cancelling or re-running unaffected work.

### Generic policy and fingerprints

`AI_FEATURES` remains the only prompt-version authority. Add a small typed refresh
policy registry connecting eligible features to target selectors and evaluation
adapters. Start with `mailbox-triage`, `mailbox-relevance`, `field-suggestion`, and
their actual overflow dependencies. Unsupported interactive/extraction/embedding
features declare no automatic policy and are not swept.

Extend `FIELD_SUGGEST_REGISTRY` to own refresh basis/dependency declarations.
Normalize the actual decision inputs using the same pure builders used for live
inference and the decision catalog. Input signatures include relevant saved values,
resolved evidence, inheritance/classification policy, attachment availability,
and ordered reference-roster contents. Option signatures include stable values,
rendered meanings/rules, and decision semantics. Relevant meaning changes
invalidate even if the option's value string stays the same. Display-only changes
outside the rendered decision input do not invalidate.

The effective configuration stamp includes declared prompt version and relevant
rendered policy/options, so a field option edit does not refresh every other
field merely because all fields share `field-suggestion`. Prompt changes to that
shared feature legitimately affect all its pending targets. A shared overflow
prompt affects only targets that depend on it. Do not compare a randomly selected
Jev/Clef model with a default model to determine staleness; store the actual model
for provenance and compare the declared routing policy instead.

For Emails, include checksum, original completeness/attachment evidence, current
classification policy, and the applicable stage dependencies. A relevance-only
change reuses valid triage evidence and calls only relevance. A triage change
reruns triage and reaches relevance only if uncertainty still requires it; reuse
a valid identical downstream evaluation rather than calling an unchanged feature
again. A legacy Email without a trustworthy stage chain receives one evaluation
of the required chain. These dependency rules require explicit adapters; the
current broad `reclassify: true` switch is not sufficiently targeted.

### Activation and discovery

After successful deployment, send an authenticated activation request to the
deployed Worker, carrying the expected release and an idempotency token. The
Worker checks its served build release, reads its own compiled feature/policy
manifest, and commits the active snapshot plus refresh Run/dispatch intent.
Never trust prompt versions supplied by the deployment caller. Serialize
activation in the existing deployment workflow; reject mismatched release
requests and obsolete activation attempts. A failed activation step is visible
and retryable, not a falsely successful refresh rollout.

Compare exact stamps, not lexicographic dates or numeric ordering. A rollback
advances the affected feature's generation while activating the older exact
version. Repeated notification of the same activation is a no-op. First activation
discovers only eligible unresolved legacy work, not every historical record.

Use existing background delivery to launch a Run-backed `AiRefreshWorkflow`.
Extend the existing Workflow lifecycle/launcher/reconciler rather than building a
second coordinator framework. Run purpose `ai_refresh` distinguishes operator
status and retention. Group Email rosters by existing member/mailbox scope,
freeze at most 200 selections/checksums per batch, then continue with another
batch. Field targets use the same ledger with the field adapter. Stable keyset
pagination and per-batch checkpoints resume large scans without offset drift.

App-open catch-up and daily cron reconcile missing dispatch, stopped Workflow
attempts, and unfinished discovery. A lightweight recurring recovery trigger
(for example, every five minutes) wakes due retries and missed activation without
waiting a day or for the member to open the app. It performs bounded discovery
and dispatch; inference belongs in the Workflow. Activation must bypass the
ordinary catch-up cooldown or a recent app-open could swallow deployment work.

Input writers record durable invalidation intent in their transaction. For a
pending field target whose basis changes, preserve its refresh identity before
normal supersession removes it from the pending set. Changing/accepting the
target field itself settles or invalidates that intent rather than regenerating
over the new value. Reuse declaration-driven dependency information in generic
entity writes and derived DDL. Recovery reconciles these intents against live
state, including writes that bypass the normal kernel. Option-roster/meaning
changes invalidate only targets that consumed those meanings or roster queries.

### Execution, interruption, and publication

Use a bounded pool of two independent target evaluations. Do not use unbounded
`Promise.all` over a roster. Acquire a database client only for a short selection,
checkpoint, or publication operation; do not retain one while waiting on model
IO, Gateway admission, or pacing. Dependent field resolution and primary/paired
calls stay sequential inside a target. Parallel reads must obey existing database
pool constraints. Drain/cancel old-generation work before admitting replacement
work so deployment overlap does not multiply the refresh pool.

The ledger's unique work key includes target, relevant active generations, input
signature, and role. Duplicate triggers converge on it. Atomically claim an
eligible item with an attempt token and bounded deadline. Check active dependency
stamps, Run attempt, eligibility, input signature, and member state before model
IO and again at publication. Every retry is fenced by its attempt token. A late
old attempt cannot publish after a newer attempt or deployment activation.

Persist a result-ready checkpoint as soon as a result exists. Retrying publication
uses that result without another inference. Final Email publication must commit
the observation, effective routing/content decision, evaluation receipt, and
terminal ledger transition together through `publishGmailEvidence`. Retain its
source-admission, member-review, and accepted-Purchase protections. Progress
counters are derived summaries; losing a later Run progress write cannot lose the
authoritative publication receipt. Keep existing public manual receipts readable.

For Suggestions, one transaction rechecks current state, inserts replacements,
supersedes only the captured pending predecessors, optionally applies the primary
addition, writes audit/acceptance receipts, and completes the evaluation. No
supersession happens merely because inference started or failed. A valid terminal
no-proposal/ambiguity outcome may retire obsolete predecessors with an explicit
reason, without inserting a fake Suggestion. Avoid the existing broad update that
can supersede a newer pending row created during inference.

Use shared conditional review transitions for accept, reject, correction, and
refresh. Rejection/acceptance that wins during inference must cause stale refresh
publication to abort. Generation and relevant evidence/member snapshots are
checked inside the transaction, not only before awaiting the provider. Existing
transactional fences are infrastructure safety, not household reservations or
multi-user coordination.

Bound automatic reinference when a crash loses an upstream result: three total
attempts per logical evaluation is the initial default, with durable backoff and
the same work identity. Report that these may be duplicate provider calls; promise
only idempotent publication. Exhaustion produces a visible terminal failure with
operator retry. Retry transport/admission failures; do not reinterpret a genuine
uncertain result, `none`, `no_signal`, `no_candidates`, incomplete evidence, or
permanent missing source as an inference failure. Those are completed/blocked
outcomes for the same fingerprint. Wake them only on relevant evidence/meaning/
version change or an explicit operator action. Reconnected mailbox authorization
can wake paused-auth work; a permanently missing original is not periodically
refetched forever. Queue delivery retries do not reset the ledger budget.

### Acceptance, rejection, and history

Add typed `acceptanceReceipt` and `supersessionReceipt` JSON to Suggestion.
Acceptance stores automatic/member mode, acceptance Run, exact entity-write
AuditLog receipt references, decision/evaluation reference, timestamp, reason,
confidence and applied policy/threshold. Rejection with a member correction also
retains its write receipt. The generating `runId` remains the generating Run;
acceptance may belong to a different Run. Bind automatic writes to the refresh or
sweep Run's actor context and explicitly identify the system action.

The generic audited mutation helper must return/capture the actual audit receipt
in its transaction; never recover it by a racy “latest audit row” lookup. An
automatic application rolls back if the field write, applied state, or acceptance
receipt cannot commit. Finance fingerprint/inheritance/policy guards remain in
force; failed application leaves a reviewable pending proposal and a diagnostic.
No automatic correction of a nonblank applied/member value is introduced.

Keep original values, probabilities, model, pair keys, provenance, correctValue,
and member decisions immutable. Supersession adds reason, timestamp, and successor
evaluation/replacement references; it is neither a rejection nor a grading miss.
Retain paired predictions even when only the primary proposal is reviewable.
Protect these Runs/children from routine pruning and define existing delete/merge
lifecycle behavior explicitly before adding new FKs.

Suppress a previously rejected semantic proposal for the same live target. Reuse
the existing canonical candidate-key helper/dismissal mechanism where applicable,
with stable field/value identity; do not key rejection suppression by prompt
version. Conservatively suppress identical legacy rejected values when old
meaning is unknown. Cosmetic description edits cannot resurrect a rejection.
A genuinely different candidate may be proposed only while the field still has
eligible unresolved work. A rejected-only target is not selected simply because
a prompt changed. Member correction or application settles the target.

Independent Luna/Sol judgment is permitted for any prediction with adequate
original evidence. Record/report judge identity/version and evidence identity
separately from member labels and acceptance mode. If historical evidence is gone,
grade unavailable rather than substitute today's record or newly regenerated
proposal. Update the grading skill's “applied means correct” shortcut; neither
automatic nor member acceptance alone determines the independent model grade.

### Shared AI Gateway egress

Add one `AiGatewayEgressDurableObject` per actual gateway identity, outside the
ChatGPT subscription branch. It coordinates applicable aggregate rate windows,
route/provider cooldowns, bounded concurrent requests, and admission deadlines.
Streaming responses pass through without whole-body buffering; in-flight permits
are released on stream completion/cancellation/error, not when response headers
arrive. Durable deadlines recover permits after an interrupted instance. Do not
hold `blockConcurrencyWhile` across upstream inference; explicitly schedule
admission and track in-flight tokens.

Cloudflare's [limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
state that 200 requests per 60 seconds per gateway applies to Unified Billing
with Cloudflare-managed credentials, not BYOK. Confirm deployed route billing and
dashboard policies before configuring it. For applicable traffic, use a rolling
60-second aggregate budget below that ceiling (initially 180), with configurable
headroom and bounded parallel in-flight requests. Route-specific buckets cannot
replace the shared per-gateway budget. Track each actual request, retry, repair,
and fallback; application-cache hits consume no Gateway admission. Gateway cache
lookups still make requests and must not bypass admission.

Honor numeric/date Retry-After and share observed cooldowns. A Gateway-wide
throttle cools the aggregate bucket; a proven provider-specific throttle cools
its route. Unknown scope is handled conservatively. Preserve raw diagnostics and
existing credential scrubbing. Background work stores a next-admission time and
defers durably; interactive work waits only within its deadline, then receives
an explicit retryable result. Rate waiting must not consume the model-failure
budget before any request is sent. Avoid multiplying DO, SDK, decision-model,
Workflow, and queue retries: callers own the bounded logical retry policy; the
DO owns per-attempt admission/cooldown and reports each attempt. Keep its
short synchronous admission-state updates separate from upstream IO; Cloudflare's
[Durable Object state contract](https://developers.cloudflare.com/durable-objects/api/state/)
documents the blocking and timeout behavior of `blockConcurrencyWhile`.

Route both `gateway.ts` and purchase-agent provider egress through this DO. Keep
the server recipe forwarder on that path. The subscription route retains its
session, cancellation, and deadline behavior and bypasses Gateway rate controls;
an explicitly authorized paid fallback acquires Gateway admission at that point.
This is not a spend-control project.

Local eval/CI/Tester Army REST callers currently bypass production Worker egress.
Use a distinct evaluation gateway with its own identity/budget, or an authenticated
coordinated egress path for callers sharing production's gateway. Do not claim a
globally enforced production budget while direct same-gateway tooling bypasses
it. Prefer the separate evaluation gateway; configure executable resource names
in code, not duplicated prose. Actual live provider quotas and external callers
remain outside the guarantees of a local counter, so retain reactive 429 handling.

## Exact implementation units

All implementation stays with the main agent; no parallel edit lanes are needed.
Default host assignments: Anthropic Opus 5.5/medium or OpenAI gpt-6.1-sol/low,
preserving the user's active main model. Migration/write-fence work raises effort
per model-routing. Main owns architecture, migration, generation, integration,
and final validation. Independent infrastructure/migration reviews use the
documented Fable/high and other-provider reviewer or Astra/high lanes before
shipping; they own no edits. This session's search agent was read-only.

1. **Contract and storage; main owner.** Add
   `packages/schemas/src/ai-evaluation.ts` for ledger, dependency stamps, receipts,
   and refresh input/progress schemas. Modify `child-tables/run.ts`,
   `child-tables/email-observations.ts`, `email-observations.ts`, `ai.ts`,
   `activity-fields.ts`, `run-fields.ts`, and the Run entity declaration.
   Add the typed activation metadata reader/writer under `server/repo/ai-refresh.ts`.
   Generate database/client outputs and immutable additive/data migrations in
   `apps/web/drizzle/`. Depends on no other unit. Validation owner: main.
2. **Target provenance and publication; main owner.** Extend
   `ai/{features,decision-model,selection,run-feature}.ts`,
   `ai/field-suggest/{registry,suggest-fields}.ts`, `runs/suggestion-sweep.ts`,
   `repo/suggestion-review.ts`, `repo/audit-log.ts`, generic
   `entity-kernel/entity-operations.ts`, and relevant finance write receipt paths.
   Add `server/ai/evaluation.ts` as the shared evaluation/receipt helper.
   Extend `gmail/{ingest,observations,admitted-source,reclassify}.ts` with targeted
   stage evaluation and atomic refresh receipts. Preserve existing manual public
   behavior while sharing the safer publication primitive. Depends on unit 1.
   Validation owner: main.
3. **Gateway coordination; main owner.** Add
   `server/ai/gateway-egress-durable-object.ts` and its Zod RPC contract. Modify
   `server/ai/gateway.ts`, `server/purchase-agent/cubby-ai-provider.ts`,
   `server/purchase-import/agent-host.ts`, `cf-env.ts`, `worker-bindings.ts`,
   `cf-server.ts`, `wrangler.jsonc`,
   test runtime bindings, and shared Gateway routing helpers where necessary.
   Configure isolated eval Gateway routing in `apps/web/tooling` callers and the
   CI declaration if that option is chosen. Subscription bypass is mandatory.
   Depends only on the transport contracts, and precedes automatic refresh.
   Validation owner: main; required infrastructure review.
4. **Discovery and durable runner; main owner.** Add
   `server/ai/refresh-policy.ts`, `server/ai-refresh-workflow.ts`, and the shared
   runner under `server/runs/ai-refresh.ts`. Extend
   `workflow-runs/{contract,launcher,lifecycle,control}.ts`, generic background
   task/queue message declarations, `background-tasks/handle.ts`,
   `services/catch-up.service.ts`, `cf-server.ts`, and Workflow bindings.
   Add an activation-only credential and authenticated internal release-activation
   handler: the credential permits activation/status, not arbitrary entity or
   inference calls, and is provisioned in Worker secrets and the existing deploy
   environment. Add the post-deploy hook in `.github/workflows/deploy.yaml`.
   Extend declaration-driven entity invalidation
   and `db/derived-ddl.ts` to retain pending-target intent. Expose narrow owner-scoped
   status through existing Run operations/contracts; no private raw identities
   leak into public status. Add evidence-retention guards for `AiEvaluation` to
   `gmail/discovery.ts`'s `pruneRoutineRuns`, and declare its Run/target lifecycle
   in the generic delete/merge policy. Depends on units 1-3. Validation owner: main.
5. **Owning docs and cleanup; main owner.** Update `docs/development.md` for
   refresh architecture, `docs/infrastructure.md` for Gateway coordination,
   `purchase-import/README.md` for stage-targeted Email recovery, and
   `docs/runbooks/production-migrations.md` for additive rollout/recovery checks.
   Update `.claude/skills/decision-grading/SKILL.md` for independent grading and
   acceptance evidence; use writing-for-agents when editing the skill.
   Remove `docs/todos.md`'s background Reclassify item only if manual Reclassify
   actually migrates to the new runner. Otherwise retain its remaining scope.
   Delete this plan after implementation, with durable contracts moved to their
   owners. Depends on verified implemented behavior. Validation owner: main.

Delete supersede-before-insert refresh behavior, unguarded rejection publication,
and duplicate per-feature orchestration after callers migrate. Preserve the
existing paced helper if unrelated consumers still use it. Do not delete current
recovery/supersession regressions or semantic-repair behavior merely because a
new generic path exists. Do not split all field suggestions into new AI features,
flush every cache, touch settled Emails, or create a standalone grading platform.

## Migration and rollout

Use additive nullable provenance/receipt links and a new declared ledger. Backfill
only exact, unambiguous evidence. Suggestion history without a trustworthy version
stays unknown. Existing applied/rejected/superseded rows, values, pairs,
correctValue, Email observations/labels, and AuditLog rows are unchanged. Legacy
acceptance receipts remain null/unknown: do not infer a member or automatic action
from confidence. Preserve row counts and old-column checksums in a disposable
restored-data migration rehearsal. Verify FKs, delete/merge behavior, and catalog
parity. New Run purposes must be included in any purpose constraints and lifecycle
policies, not only UI labels.

One production migration owner follows the production migration runbook:
establish preservation, apply/read back compatible expansion before merge, then
deploy matching code. No data reset or destructive contraction is needed.
Production actions require the subsequent implementation task; this plan performs
none. Historical backfill must not create false successful evaluation receipts.

Roll out contracts and Gateway admission first, with automatic refresh disabled.
Verify subscription bypass, streaming, aggregate admission, and exact audit links.
Run aggregate-only discovery in dry-run mode and inspect eligible/blocked/unknown
counts per feature without publishing household records. Activate one feature and
one bounded batch, verify deterministic receipts and preserved settled data, then
enable automatic activation and evidence invalidation. Headroom/concurrency/retry
values live in executable configuration and may be tuned from observed waits and
429s. Jev/Clef cost is not a gating concern.

Emergency disable stops new admission and cancels/fences refresh attempts; it does
not revert applied values or erase history. Rollback activates the supported older
feature stamps and new generations. Once a database contract is shipped, rollback
only to code that supports it; an older incompatible binary is not a safe rollback
target. Never leave old ungated egress and coordinated production egress active
while claiming a strict aggregate budget. Recover an interrupted batch from ledger
receipts/results, never from observations or Run counters alone.

## Failure scenarios and narrow validation

Write these failures and any necessary isolated tests before implementation.
Prefer one deterministic system-boundary scenario with a synthetic Gateway peer,
real database, and real queue/Workflow publication over duplicated unit coverage.

- Change only relevance: uncertain eligible Email refreshes; triage, confident
  Emails, member resolutions/labels, accepted imports, and field suggestions do not.
- Change field-suggestion or one option meaning: only appropriate pending targets
  refresh; applied/rejected history survives; identical rejected proposals stay
  suppressed; inherited/forbidden fields are refused.
- Deliver activation twice, resume after a failed dispatch, and roll back to an
  earlier version: one logical target per active signature, no late old-generation
  publication, and unaffected features do not get re-evaluated.
- Race accept/reject/correction/target edit/basis edit against a held inference:
  the winning member decision survives; a newer pending proposal is not superseded;
  basis-only invalidation retains its durable refresh intent.
- Crash before inference, after result-ready, and during final publication:
  committed outcomes are replayed without a new call; an unknown upstream outcome
  may reinfer within the fixed budget; insert/supersede/apply/audit/receipt rollback
  together. Failure updating derived Run progress does not repeat a committed item.
- Produce ambiguity, no candidates, missing bytes, and a permanent source 404:
  repeated scans of the same signature perform no further inference/fetch loop;
  a real evidence change wakes the target. Auth failure resumes after reconnect.
- Seed 201 synthetic Emails: batches never exceed 200; interruption/deferred work
  resumes the exact remainder with the right owner/mailbox/checksum. Pool concurrency
  never exceeds two refresh targets, including retries and deployment handover.
- Auto-apply a primary high-confidence blank addition: the value, applied status,
  generating evaluation, acceptance Run, and actual AuditLog entries agree. A
  nonblank correction remains pending. A finance freshness refusal remains visible.
- Independent grading reads the original primary/paired and superseded prediction;
  acceptance status does not become the model's grade. Missing historical evidence
  is unavailable. Legacy provenance remains explicitly unknown.
- Flood coordinated Unified Billing egress from multiple callers: aggregate starts
  remain below the configured rolling budget, retries/repair/fallback count, 429
  cooldown is shared, and restart/cancel releases bounded in-flight capacity.
  Slow streams do not monopolize unrelated route capacity; response bytes/headers,
  aborts, Gateway IDs and raw errors survive. Subscription calls bypass this limiter.
- Migration fixture preserves existing history/counts/values and gives unknown
  legacy targets one eligible evaluation; repeat migration/reconciliation cannot
  falsify provenance or erase settled history.

Retain and extend the existing
`gmail/reclassify-recovery.integration.test.ts`,
`gmail/publication-concurrency.integration.test.ts`,
`runs/suggestion-supersede.integration.test.ts`,
`runs/suggestion-review.integration.test.ts`, and
`runs/suggestion-sweep.integration.test.ts` regressions. Add focused PostgreSQL
coverage for ledger uniqueness/atomic publication and a Workers DO test for
rate-window/stream lifecycle behavior, where the system journey cannot expose
those failures. Reuse `decision-model.unit.test.ts`'s Retry-After cases rather
than duplicating them at every caller.

During implementation: run the affected `pnpm test:postgres <path>` or
`pnpm test:file <path>` cases, the real Workflow/queue system scenario, one affected
app/test typecheck, generation/declaration strict probe and drift checks, and
schema/catalog/migration checks. Use workflow-routing validation for deploy/CI
changes. If public Run/Suggestion receipt shapes change, generate every client
and run focused native decoding contracts; bump Apple compatibility only for an
actual wire break. The final exact PR head needs the canonical CI merge gate and
infrastructure/migration reviews. Do not rerun broad suites locally without an
identified need. Synthetic live Gateway evaluation remains explicitly optional;
inspect the exact merged #1982 tooling before naming its final command.

## Observability and recovery

Existing Run status is the operator surface. Show active feature/version/generation,
changed dependencies, total selected, completed/blocked/obsolete/failed counts,
due retry count, age of oldest unfinished item, attempts, and dispatch state.
Distinguish evaluated uncertainty from a failed request. Gateway telemetry adds
admission wait, applicable bucket, in-flight count, actual attempts, shared cooldown,
429 scope, and cancellation/stream completion. Use existing tracing/Sentry and
credential scrubbing; do not archive private prompts or originals in logs.

Alert on failed activation/dispatch, overdue unfinished items, exhausted retries,
publication-fence refusals that do not drain, or sustained Gateway 429/wait growth.
Operator recovery replays activation, resumes/retries a Run, or retries a failed
target using the existing lifecycle surface. Revalidate current configuration and
member state before any retry. Restarts do not clear fingerprints, rejection
suppression, successful outcomes, or the attempt history. Aggregate rollout counts
are safe outward-facing evidence; private candidate lists remain in the application.

## Alternatives and adversarial readiness review

- **Join existing provenance only:** smallest migration, but Run grouping,
  best-effort usage, missing Suggestion versions, and final-stage-only Email
  observations prevent reliable targeting. Rejected.
- **Add only Suggestion.promptVersion:** answers one lookup but cannot remember
  a no-proposal result, upstream/overflow dependencies, or interrupted publication.
  Rejected in favor of a shared evaluation link and ledger.
- **Broad reclassify/sweep on deploy:** easy orchestration but reruns unrelated
  stages and threatens settled/member work. Rejected.
- **Only daily scanning:** eventual recovery but delayed deployment response and
  no transactional invalidation intent. Retained as recovery, not the primary trigger.
- **New custom refresh Durable Object:** viable but duplicates existing Workflow
  attempt/cancel/status infrastructure. Use a Run-backed Workflow; reserve the new
  DO for shared Gateway egress, which currently has no equivalent.
- **Only Gateway retries or a queue concurrency setting:** does not coordinate
  the shared rate budget across interactive, agent, background, and tooling paths.
  Rejected. Existing application cache and Gateway admission solve different issues.
- **Unlimited parallelism/retries:** unnecessary with cheap decisions; it increases
  pool/rate pressure and can spin on genuine ambiguity. Use bounded independent work.

Confirmed highest-impact blockers in a naive plan are incomplete provenance,
non-atomic suggestion replacement/acceptance, publication-versus-receipt gaps,
and ungated direct Gateway callers. The design above supplies explicit contracts
for all four. Merely adding a registry version field or launching existing sweeps
does not address them.

Implementation-ready at the design level. Before shipping, verify actual deployed
Gateway billing/limits, exact #1982 head/merge/deployment, existing data preservation
in the migration rehearsal, stream cancellation under the real binding transport,
and all generic lifecycle registrations. Those are environmental/implementation
checks, not silently assumed facts from this planning session.

## Checks performed in this planning session

Read-only repository inspection, schema/caller/test/doc tracing, Git status/HEAD,
GitHub PR and deployment workflow metadata, and official Cloudflare limits docs.
One read-only search/extraction agent supplied Email/Gateway evidence; main checked
the consequential publication, audit, registry, Workflow, and migration boundaries.
The new plan passed a trailing-whitespace scan. `git diff --check` also returned
success, but an untracked plan is outside that command's diff coverage.

Not run: automated tests, app/test/native typechecks, lint/format hooks, generation
or drift checks, database/migration/catalog checks, browser/device journeys, live
Gateway inference/evaluation, production candidate counts, live Worker release
verification, Cloudflare dashboard policy inspection, production migrations,
deployment, CI reruns, or independent implementation reviews. No implementation
files or existing history were changed or deleted; only this proposed plan was added.
