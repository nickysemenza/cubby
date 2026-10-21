# Infrastructure dependencies

This file is Cubby's infrastructure-as-documentation source of truth. It is
the reconstruction checklist in lieu of Terraform: every production dependency
should have an owner, a stable identifier, a creation or configuration path,
and a verification command here. Secret **names** belong here; secret values do
not.

The provider remains authoritative for live state. When this file and a
provider disagree, investigate the drift before changing or deleting anything.
Update this file in the same pull request that adds or removes an infrastructure
dependency.

## Production topology

| Concern                       | Provider                           | Production resource                                                                      |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- |
| Web application and APIs      | Cloudflare Workers                 | Worker `cubby`, custom domain `cubby.nickysemenza.com`                                   |
| Purchase-import orchestration | Agents SDK + pi-durable            | Worker `cubby`: queue `cubby-purchase-agent`, Durable Object `PurchaseImportRunAgent`    |
| PostgreSQL                    | Neon through Cloudflare Hyperdrive | One Neon origin, two Hyperdrive configurations                                           |
| Images and documents          | Cloudflare R2                      | Bucket `foo`, public origin `https://media.nickysemenza.com`                             |
| Product lookup                | Main Worker + PostgreSQL           | `UpcLookupCache` table, upcitemdb fallback (no key)                                      |
| USDA food data                | Cloudflare Workers + R2            | Worker `cubby`: Durable Object `UsdaReleaseDurableObject`, R2 `cubby-usda-releases`      |
| AI routing                    | Cloudflare AI Gateway              | Gateway `cubby`, Workers AI binding `AI`                                                 |
| ChatGPT plan usage            | OpenAI OAuth + Responses API       | Worker `cubby`, SQLite Durable Object `ChatGptPlanDurableObject`, binding `CHATGPT_PLAN` |
| Semantic vectors              | Cloudflare Vectorize               | `cubby-openai-text-embedding-3-small-1536`                                               |
| Gmail discovery               | Google Cloud                       | Project `cubby-481519`, Gmail API, OAuth web client                                      |
| Errors                        | Sentry                             | Web/Workers project represented by the checked-in DSN; separate `cubby-apple` project    |
| Worker logs and traces        | Cloudflare Workers Observability   | Native traces; logs also exported through `grafana-logs`                                 |
| Deployment                    | GitHub Actions                     | `.github/workflows/deploy.yaml` on `main`                                                |
| Native clients                | Apple Developer/Xcode              | Associated domain `cubby.nickysemenza.com`; locally installed iOS/macOS apps             |

The checked-in provider configurations are:

- [`apps/web/cloudflare.config.ts`](../apps/web/cloudflare.config.ts)
- [`.github/workflows/deploy.yaml`](../.github/workflows/deploy.yaml)

## Cloudflare

Account ID: `9f10f078d35d86c78dedece2300a6b88`.

### Main Worker

[`apps/web/cloudflare.config.ts`](../apps/web/cloudflare.config.ts) owns Worker bindings,
Durable Objects, Workflows, queues, placement, asset routing, crons and plaintext
variables. Deploy creates/updates those resources. This page records provider
state and reconstruction constraints that configuration cannot reproduce.

Vectorize's string metadata index is named `entityType`: that provider-side
name predates `entityKind` and must remain when recreating the index.

### Workflow-backed Runs

Mailbox discovery is a Workflow-backed Run. Its page/retention/admission
contract lives in the [purchase-import module guide](../apps/web/src/server/domains/purchase-import/service/README.md#mail-import-end-to-end).
Workflow instances are attempts, not the durable record; retries must resume
persisted progress without depending on provider retention. Instance diagnostics
expire independently of Run history. The Run's Cloudflare dashboard link requires
provider sign-in and can outlive the instance.

Deployment configuration, dispatch and Run dashboard links use the shared
Workflow declarations in `lib/workflows/run-workflows.ts`; a purpose
selects its binding there, including every purpose sharing the step runtime.

The step runtime memoizes a checkpoint inspection before naming each page.
Names show its declared phase and scope, for example `generate p4 · charges
61–80 · statement_transaction`; the range is a planned bound, not a promise that
the last page is full. The ledger step key keeps identical phase/page labels
from different steps from sharing a replay result.
Only persisted checkpoint counts and declaration constants enter names, because
[step names are replay cache keys](https://developers.cloudflare.com/workflows/build/rules-of-workflows/).
Inspection adds two reads per page (and initializes a missing ledger once),
never a live candidate count or a model call. Page outputs retain phase, unit,
page processed count, cumulative phase processed/total/failures across instances,
and supported reused/new label counts. The cursor is a RunStep id and checkpoint
ordinal: private driver cursors remain in PostgreSQL. No observations, descriptors,
model prompts or label values are copied into dashboard outputs.
Deployment guards report pinned/current version ids and their handoff reason;
handoffs report queue acceptance, the requested successor id and the last
committed counts. Queue acceptance does not prove the successor has launched.
Outputs stay constant-sized, far below the non-stream
[step result limit](https://developers.cloudflare.com/workflows/reference/limits/).
Pinned instances retain their old code and step names until their normal
handoff. No Run checkpoint migration or restart is required.

Step-ledger Runs hand off after bounded committed pages; the subrequest cap
belongs to the Workflow instance, so a new `step.do` alone does not reset it
([Cloudflare limits](https://developers.cloudflare.com/workflows/reference/limits/)).
Statement Sweeps also bound generation and label page sizes. The driver owns
those executable bounds; continuation retains the RunStep cursors and the
attempt/cancellation fences instead of starting generation over.
`packages/shared/src/workflow-platform-limits.json` owns the platform allowance.
Deployment config reads its bytes; the runtime `WORKFLOW_EXECUTION_LIMITS`
policy imports it to size application paths. Keep runtime modules out of the
deployment config import graph: the Cloudflare Vite plugin denies config
dependencies to the runtime loader. Use relative URL file reads for shared data;
the config loader also tracks `import.meta.resolve()` targets as dependencies.
The policy configures a four-million
subrequest allowance, 512 suggestions / 1,024 new questions per model page,
three batch attempts and a 500-page hard ceiling. Model pages spend 1/65 and
database-only pages 1/400 of one shared allowance across all phases. Generation
that also speculates on model answers spends the model share. Unknown drivers
and child waits use the conservative fallback share; changing phase does not
replenish the allowance. There is no elapsed-time rollover.

Statement generation commits at most 512 charges per page. It overlaps the next
generation page with bounded computation for already generated suggestions.
Speculation reads the generation's published judgment and retains per-question
answers and evidence identities in existing checkpoints; it neither publishes conclusions nor applies rules. Its admission
window is bounded by question count, encoded evidence bytes and preparation time.
The generation write lane settles before speculative checkpoints publish. After
all generation and separately paged vanished-hold checks, labels consume those
answers in the original `(createdAt, id)` order, rebuilding fresh evidence before
publication and discarding incompatible answers.
Transfer discovery finishes before statement work. Its raw seed/pair cursor
retains complete competitor pools and resumes oversized fanout; retirement starts
only after discovery coverage and freshly verifies bounded stored-identity pages.
A charge reserves missing decisions before inference; candidates are never truncated.

Both labelers submit a whole page's independent questions to the shared decision
runner. Statement identity, kind and counterparty answers use their original
per-question evidence; neither create vote depends on another model answer.
Transfer pairs submit both legs together across the page. Feature, sampled
Jev/Clef model, usage context, media, question count and serialized context bounds
still determine actual request groups. The gateway's 180/minute limit counts
requests, not questions or completed suggestions; batching can complete many
suggestions per admitted request. Prompts, confidence thresholds, per-question
cache keys and model selection remain unchanged.

Model work holds no publication transaction. Statement checkpoint/publication
runs at `STATEMENT_PUBLISH_CONCURRENCY = 4` against the twelve-connection
Hyperdrive pool. Transfer-pair builds and publications share a separate
four-slot DB lane; movement decisions run outside it. Pool connections are
leased for database operations, never across model latency.
A partial label page saves its unpublished judgment in the pending
AssessmentState and resumes inclusively at the earliest unfinished suggestion,
independently of completion order. Compatible evidence re-exports retain paid
labels. A member-settled or suppressed charge is skipped; moved evidence remains
queued when any rule round yields. Cache/admission contention yields Workflow
label work after one admission attempt, checkpoints all started work, then
requests a durable wake no sooner than fifteen seconds after contention.
Checkpoint/publication time can consume part of that interval before `step.sleep`.
Transfer-pair Workflow pages also return a durable wake time and resume before
the earliest deferred pair, retaining completed publications; a null cursor
with a wake time means retry from the start, never completion.
Interactive callers retain their waiting behavior. Pages retain a 15-minute
platform timeout; decision requests retain their 30-second deadline. Temporary
item failures retain completed answers/effects, persist a bounded retry deadline,
and retry the input checkpoint before advancing. Exhausted items remain visible
and skipped identities are deduplicated within that bounded retry batch,
while independent work continues. Cancellation is final. Model publication saves
an application-pending receipt atomically; dependent application or statement
refresh clears it only after completion, so a crash cannot silently drop that stage.
Statement label-round logs retain logical charge and question counts.

The static application-path allowance assumes **no batching savings**:
`65 model pages × 1,024 questions × 3 attempts × 16 transport operations = 3,194,880`,
leaving over 800,000 operations for bookkeeping, continuation and
recovery. The runner sums phase shares; database-only work permits at most 400
pages before continuation. The separate 500-page ceiling still applies.

Sixteen allows three cache claims, three invalidations, two lease renewals during
the 30-second decision deadline, three provider attempts with DO/upstream
transport, publication/release and telemetry. Repeated invalid-cache replacement
races stop after three rejected entries and compute uncached. Busy Workflow
cache/admission paths yield after one lookup rather than polling. A retry
reserves the full page allowance again even when individual cache hits avoid it.
This is conservative application-path sizing, not a platform usage meter; SQL
over Hyperdrive is not one HTTP subrequest per query. Explicit caller limits
cannot enlarge a label page or its new-question allowance.

The egress DO forwards each admitted model call in one request/response round
trip and owns completion/permit release. Rejection does not poll inside a
Workflow page or increase RPC ancestry. Cloudflare defaults to 10,000
subrequests per instance and permits configuration up to ten million; Cubby
configures four million. The separate step-count ceiling remains 10,000 by
default. Page wall time is unlimited by the platform, while active CPU is
bounded independently ([Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/)).
The real-DO regression verifies 180 admitted starts in a rolling minute with
synthetic ten-second request lifetimes. The full synthetic Sweep regression
measures completed suggestions through actual batching, PostgreSQL publication,
page checkpoints and Workflow handoffs; its reported latency costs are simulated
capacity evidence, not production measurements. The virtual clock charges model,
label-publication and handoff latency, and waits for outstanding real SQL before
advancing; host PostgreSQL/setup time is reported separately and excluded from
that capacity estimate.

Page failures are logged before database failure bookkeeping. If bookkeeping
also fails, the original error and the complete recording-error chain survive
in the retry's message. Failure status and timeline commit together, so a
partial failure cannot make the next retry skip the combined diagnostic.
Each Workflow failure-write retry opens a fresh database
scope. If all retries fail, the combined raw diagnostic is the terminal instance
error, allowing reconciliation in a later invocation to save it on the Run.
Only credential-shaped values are scrubbed; SQL, parameters, SQLSTATE codes and
upstream bodies remain visible. An unrecoverable CPU termination can bypass
JavaScript catches and must be diagnosed from provider invocation outcomes.

Retired executor purposes preserve recorded inputs/checkpoints but cannot resume.
Catch-up reconciles attempts that ended without finishing their Run. Discovery
readiness and usage reads remain storage-only; current cursor coverage is not a
snapshot of one historical Run and a read never grants execution.

Workflow instances keep their creation version across deploys. Cloudflare's
[instance API](https://developers.cloudflare.com/api/resources/workflows/subresources/instances/methods/get/)
reports each instance's `versionId`; it does not document a hot migration of
in-flight steps. Read-only provider inspection confirmed an older Workflow
version still starting steps after newer versions were deployed.

Every Workflow checks deployment at a committed page or target-cycle boundary.
The active page finishes first, including its publication and cursor checkpoint.
The Workflow compares its own `CF_VERSION_METADATA.id` with the Gateway Durable
Object's running version, not the stored AI-refresh activation `release` or
observed-version marker. Durable Objects follow deployments
([Cloudflare version guarantees](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/));
the DO accepts successor dispatch through the shared background queue. A fresh
queue-consumer invocation creates the successor through current bindings, behind
the persisted attempt and cancellation fences. Duplicate deliveries are harmless.
The old DO RPC remains an enqueue-only bridge for pinned Workflow versions.
The former synchronous Workflow → DO → Workflow creation path is confirmed in
code; Cloudflare documents a separate 16-invocation Worker loop limit, but does
not establish whether ancestry propagates across these Workflow instances.
Queue dispatch removes that dependency without relying on a failed retry.
Queue acceptance is the dispatch boundary. A lost delivery uses the existing
30-minute quiet-Run reconciliation and cron/app-open recovery; a delivery later
than that grace can be diagnosed as an ended attempt and consume the bounded
infrastructure-recovery allowance.
A rollback is a
version change too. Version checks are durable steps: replay reuses each recorded
decision instead of moving the handoff backwards over already-completed work.
Persist that decision in its own step before dispatching the successor: a lost
create reply followed by rollback must not let the predecessor resume the same
checkpoint. Each RPC attempt acquires a fresh DO stub because an exception can
leave the previous stub permanently broken
([Cloudflare error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)).
At an instance's first boundary, allow one bounded page without a version RPC
or settle sleep; forced instance-budget handoffs still apply. A fresh Workflow
can reach a DO still running the preceding deployment in another location
([DO lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)).
The next committed-page boundary compares versions normally, including rollback.
This gives deployment propagation useful work to catch up and prevents
zero-progress successor loops. Even a freshly created older pinned instance
can run only that bounded page before rechecking; an in-flight page has the
same committed-page cutover contract. The DO is a running-version observation,
not an atomic global deployment authority; lag can still cause an unnecessary
handoff at a later boundary.

Run-backed Workflows reuse `claimWorkflowRun` and the `launchWorkflowRun`
`expectedAttempt` fence. The same Run retains its cursors, receipts and cancellation;
only the attempt changes. Cancelled, finished or superseded owners cannot relaunch.
The existing stuck-Run reconcile still repairs interrupted dispatches. Search
repair has no Run: its deterministic successor carries the committed phase,
cursor, counters and original request timestamp, and its progress subscription
follows that successor without reporting a premature completion.
Successor creation uses `createBatch`'s documented duplicate code rather than
matching `create()` error text, so a lost response safely reuses the same instance.
Instance page bounds remain a fallback even without a deploy; idle AI waits recheck within a
minute. An active page and its retries can delay cutover until its checkpoint.

This rule first applies to instances created with the boundary check installed.
Instances already executing older code cannot acquire that check from a deploy;
their existing bounded continuation or an explicitly authorized operator action
must create the first updated instance. Production deploys send all traffic to
one version; this does not select a globally newest version during a gradual
deployment with multiple active versions.

One-time creation commands that cannot be inferred or safely rerun by deploy:

```bash
pnpm --dir apps/web exec cf queues create --queue-name cubby-background
pnpm --dir apps/web exec cf queues create --queue-name cubby-image-cloud
pnpm --dir apps/web exec cf queues create --queue-name cubby-telemetry
pnpm --dir apps/web exec cf queues create --queue-name cubby-purchase-agent
pnpm --dir apps/web exec cf vectorize create \
  --name cubby-openai-text-embedding-3-small-1536 \
  --index-config-dimensions 1536 --index-config-metric cosine
pnpm --dir apps/web exec cf vectorize metadata-index create \
  cubby-openai-text-embedding-3-small-1536 \
  --property-name entityType --index-type string
```

The Workflow, Durable Object namespaces, bindings, consumers, crons, and route
are created or updated by `cf deploy` from the checked-in configuration's Build Output.

### Purchase agent

The purchase agent coordinates import runs inside Worker `cubby`: an Agents
SDK `Agent` hosting a pi-durable conversation through `PiHarness`. Its
checked-in configuration is part of `apps/web/cloudflare.config.ts`:

- SQLite Durable Object class `PurchaseImportRunAgent` (binding
  `PURCHASE_IMPORT_RUN`), one instance named `import-run:<Run.id>` or
  `photo-inventory:<Run.id>` per run (`importRunAgentIdentity`); pi keeps the
  transcript, inbox, and tasks in the object's SQLite, and Lifecycle jobs wake
  it through its alarm after eviction;
- the `cubby-purchase-agent` queue consumer (`server/domains/purchase-agent/service/queue.ts`),
  which fences duplicate and late `start_or_resume` deliveries with the Run's
  dispatch generation (`canDispatchCoordinator` / `acknowledgeCoordinator`),
  retries a transient failure, and fails the Run after three attempts;
- every model call through AI Gateway `cubby` on the Worker's `AI` binding,
  by the shared pi-ai providers (`@cubby/shared/ai/pi-providers`). The gateway
  shim disables parallel tool calls: pi ends a run on a terminating tool only
  when it is the round's sole call. A paid- or credit-admission refusal
  (household AI budget, Run no longer executable) reaches the coordinator as an HTTP 403 carrying its
  reason, not a network error;
- each request's context per the purpose's `workItemContext`
  (`@cubby/schemas/import-run-agent`): Mail import sends only the kickoff, user
  and system messages, and the latest `claim_next_import_work` onward, because
  each Email is independent and durable records carry what earlier ones
  settled. The stored transcript keeps every Email for the Run page. A Mail
  import claim carries the Email's compact read and first settles
  rule-decided Emails without a model turn
  (`server/domains/purchase-import/service/README.md`). Each
  Anthropic request marks a cache breakpoint at the end of that kept prefix,
  and each OpenAI request keys `prompt_cache_key` to the Run
  (`withWorkItemCaching`), so the prefix is read from cache on every Email;
- the agent's `entity_read` schema narrowed to the purpose's `entityRead`
  view (Mail import: purchase, vendor and product, each with only its curated
  list filters, and no `groupBy`/`groupLevel`/`nesting`); other kinds are
  refused for the Run, omitted filters still validate, and members'
  `tools/list` keeps every kind and input. An agent tool advertises
  `_runExecution` only when one of its mounted actions reads it (Mail import:
  `purchase_import`, `finance`). The ChatGPT plan transport places the tool
  block before the conversation so the plan's prefix cache covers it
  ([runbook](runbooks/chatgpt-plan.md)).

The Run page observes without resuming work. Opening a harness resumes its
pending tasks, so `/stream` from an object whose agent is already constructed
for Run work is the agent's live push stream; every other observation reads the
retained pi_ SQLite tables (`agent-transcript.ts`, version-fenced). Both
include pi's own `pi.usage` token totals per model (`model-usage.ts`), which
the Run page compares against the Run's `AiUsage` rows to expose calls the
usage hook missed, such as compaction summaries; cost stays in `AiUsage`. The
agent's MCP calls are recorded as `McpToolCall` with `surface: in_app_agent`
and the Run.

pi-durable owns migrations of its stored tool tasks. Validate preservation of
live call identities, arguments, and replay checkpoints when upgrading it.
The host discards a failed in-memory harness after it closes and reopens the
same SQLite store on next use. An older session's late close cannot discard
its replacement.
After a task migration, a rollback must retain an SDK that can read the migrated
state.

**The trust boundary.** The agent reads untrusted mail and photos, so prompt injection must not reach anything beyond the run it serves.
It was a separate Worker with no database credential for that reason; it now
runs in this Worker behind an in-process boundary enforced by construction:

- The agent's code (`apps/web/src/server/domains/purchase-agent/`) receives no `env`.
  Its host (`server/domains/purchase-import/operations/agent-host.ts`) builds a narrowed
  environment (`server/domains/purchase-agent/service/environment.ts`): the AI Gateway, the
  scripted test model in the workerd harness, the purpose's MCP tool
  definitions, and the services of the one Run the object's name identifies
  (`importRunIdFromAgentIdentity`), so a coordinator cannot address another
  Run. The queue consumer gets a separate environment that resolves any Run's
  services and coordinator. The Agents SDK base class gets an empty
  environment.
- Every Cubby effect is a Run service (`server/domains/purchase-import/operations/agent-services.ts`):
  bound to one Run when created, it parses its input
  (`@cubby/schemas/purchase-agent-services`), opens its own database scope,
  and resolves every target from that Run. No input names a Run, party,
  account, vendor, SQL, script, or generic mutation target. A new coordinator
  first calls `authorize`, which requires the member's live Purchase Agent
  grant and otherwise pauses the Run for authorization.
- MCP calls run Cubby's MCP handler in process. For each request the host
  mints a fresh five-minute delegation bearer bound to the Run and the
  member's live Purchase Agent grant; the MCP handler verifies it, the grant,
  and LedgerParty ownership exactly as for any external client, and narrows
  every tool to the purpose's manifest actions
  (`importRunAgentManifest[purpose].mcpActions`). The agent never holds the
  token, and the host reads the agent's request before opening its database
  scope.
- Oxlint rule `cubby/purchase-agent-boundary` (`tools/oxlint/cubby/`) fails
  any import from that directory outside its runtime packages, pure Cubby
  contracts (`@cubby/schemas`, `@cubby/shared`, `@cubby/worker-tracing`), its
  own files, and the bundled skill Markdown, and any reach for an `env` or
  `exports` property (including `ctx.exports`, the Worker's loopback
  bindings) or the `process`, `globalThis`, `self`, and `require` globals,
  under any spelling. A new agent capability is a new Run service, never an
  import.

What the boundary does and does not cover: the model never runs code — its
only authority is the tool set, and every tool is a Run service or an MCP
call checked as above. The boundary keeps Cubby's own agent code on that
path. It is not a sandbox: the agent shares the Worker's isolate, so its
dependencies (the Agents SDK, pi) run with the same runtime authority as any
Worker code, including `process.env` populated by `nodejs_compat`. The
separate Worker also contained a compromised dependency; adding a
dependency to the agent therefore deserves the same review as one in the
web app.

One Worker removes the circular service bindings, the internal agent route
and its header marker, and the `PurchaseImportService` RPC entrypoint whose
binding was cast rather than checked; the boundary is now type-checked and
linted instead of a deployment topology.

The agent runtime (Agents SDK, pi-durable, MCP client) stays off every page
request: the exported Durable Object is a shell that loads
`server/domains/purchase-agent/service/run-agent.ts` on its first event, and the queue handler
loads the consumer when a `cubby-purchase-agent` batch arrives
(`apps/web/tooling/checks/check-server-closure.ts` budgets the static entry, browser
API bootstrap, combined page path, and total output). The API bootstrap includes
the dispatch adapter's static imports; individual operation loaders remain
separate. Startup lifecycle/progress/admission modules import the
database helpers' `core` and `query` modules directly: the barrel also
initializes relation loaders and CRUD dependencies. Refresh admission keeps its
slot query and lock in a lightweight module without AI policy, discovery or the
generated entity catalog. These belong behind their
consuming handler; the entry budget does not measure the additional imports
an API operation or page needs.

Module-scope work in the entry closure runs on every isolate start; construct
expensive objects (an `Intl.Segmenter`, compiled tables) on first use. To
profile startup, build with `pnpm --dir apps/web build:cf`, copy
`.cloudflare/output/v0/workers/default/bundle` without `*.map` into an ignored
directory beside a `wrangler.jsonc` that sets `main: "bundle/index.js"`,
`no_bundle: true`, `find_additional_modules: true`, the Worker's compatibility
date and flags, and module rules for `**/*.js` (ESModule), `**/*.wasm`
(CompiledWasm), `**/*.{md,css}` (Text) and `**/*.json` (Data), then run
`wrangler check startup --cwd <dir>`. The CPU profile is local and sampled at
about 1 ms; repeat it and compare module shares, not absolute times. Cold
latency is mostly outside this profile: production traces carry
`cubby.worker.first_invocation`, and comparing the root span with
`cf.app.entry` separates platform isolate start from handler time.

Run purposes and MCP authority are declared in
`packages/schemas/src/import-run-agent.ts`; execution, settlement and transcript
retirement follow the [purchase-import module guide](../apps/web/src/server/domains/purchase-import/service/README.md).
The shared host records model usage in `AiUsage`; transport attribution follows
[ChatGPT-plan usage attribution](runbooks/chatgpt-plan.md#usage-attribution).
Model/tool content stays out of Sentry and Workers traces.

The fixed public OAuth client id is `cubby-purchase-agent`. It uses authorization
code + PKCE, `offline_access`, no client secret, and the callback
`https://cubby.nickysemenza.com/api/import/agent/oauth/callback`. The web Worker
provisions the client idempotently when authorization begins. Better Auth's
existing `oauth_refresh_token` row is the revocable grant; its value is never
copied to the agent. The web Worker mints five-minute, run-bound delegation tokens
for MCP calls and rechecks the live grant and LedgerParty ownership on every
request.

Pi-durable conversations live in the coordinator's Durable Object, so moving
the class between Workers or replacing it does not carry them over: terminate
the Runs whose coordinator is active (`running` and `paused_*`) before such a
deploy. A queue has one consumer; to move `cubby-purchase-agent` to another
Worker, remove the old consumer first
(`cf queues consumers delete <consumer-id> --queue-id <queue-id>`); events wait
in the queue until the new consumer deploys.
Resolve these provider IDs with `cf queues list` and
`cf queues consumers list --queue-id <queue-id>`; the delete command does not
accept a queue or Worker name.

After deployment, authorize each member once from Settings and verify the
client/grant without printing token values:

```sql
SELECT c.client_id, c.token_endpoint_auth_method, c.require_pkce,
  count(r.id) AS active_grants
FROM oauth_client c
LEFT JOIN oauth_refresh_token r
  ON r.client_id = c.client_id AND r.revoked IS NULL
WHERE c.client_id = 'cubby-purchase-agent'
GROUP BY c.client_id, c.token_endpoint_auth_method, c.require_pkce;
```

The scripted workerd harness exercises the built agent without production
data; profile/provenance contracts belong in
[test runtime guidance](agents/validation-tests.md#workerd-test-runtime-and-profiles).

### PostgreSQL and Hyperdrive

Frequent crons must not open Neon merely to check for work. Keep their idle
checks in Durable Object storage; pending durable handoffs may use alarms.
Nightly maintenance is the exception and may reconcile PostgreSQL state.
AI refresh follows this rule; its scheduling details live in the
[refresh runbook](runbooks/ai-refresh.md).

Neon owns the PostgreSQL database. Production compute is autoscaling
0.25–4 CU and keeps scale-to-zero (300 s idle) by choice: the first query after
an idle gap waits for compute start (about 0.5 s median, 0.9 s p90), visible
as a long `db.connect.phase.startup` on `db.client.connect`. This range belongs to the production endpoint: changing the project's
default compute range does not resize an existing endpoint. The Hyperdrive
origin connection caps below are 12 + 12. Both configurations share origin
compute; the cached pool needs headroom for short reads while expensive reads
are running. Pool caps are soft limits, not interactive connection reservations.
Keep them below database capacity and measure origin waits and query execution
together before raising them. More connections cannot remove expensive query
work. The background
queue runs one message per invocation with `max_concurrency: 2`, a conservative
starting policy to reduce competing database work, not a measured optimum or
an interactive connection reservation. Tune it against queue backlog and oldest
message age, origin pool waits, and interactive latency together. Telemetry
concurrency remains 1. Purchase-agent delivery is serial within each batch, but
starts coordinator work outside delivery; capping that queue would not bound
active agent database work. That workload policy remains separate.

Editing Neon's autoscaling bounds restarts the endpoint and disconnects active
sessions; automatic resizing within those bounds does not. Apply a range change
away from critical writes or migrations, then verify reconnects and read latency.
Reverting the range also restarts the endpoint. See
[Neon compute management](https://neon.com/docs/manage/computes) and
[Hyperdrive pool tuning](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/).

Cloudflare has two Hyperdrive configurations pointing at the same direct Neon
connection string:

| Binding             | Hyperdrive ID                      | Contract                                                                                              |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE`        | `adc9757dfffd45bc94d5c2a66b2ad410` | Authoritative reads and writes; caching disabled; origin connection limit 12                          |
| `HYPERDRIVE_CACHED` | `427dd7a2876c4dccbe056d37fa7374ff` | Cache-eligible reads; 60-second max age, 15-second stale-while-revalidate; origin connection limit 12 |

The IDs are checked into `apps/web/cloudflare.config.ts`; the origin connection
string and cache/connection-limit settings are provider-side state. Recreate
with direct Neon origin credentials, never a pooled hostname. Prepare private
JSON request files with `name`, `origin` (`scheme`, `host`, `port`, `database`,
`user`, `password`), and `origin_connection_limit`; keep those files outside Git
and command output:

```bash
pnpm --dir apps/web exec cf hyperdrive create --body @/private/path/strong.json
pnpm --dir apps/web exec cf hyperdrive create --body @/private/path/cached.json
```

After recreation, update the checked-in IDs and reapply the connection limits
and cached binding policy. Inspect live state before deployment:

```bash
pnpm --dir apps/web exec cf hyperdrive get \
  adc9757dfffd45bc94d5c2a66b2ad410
pnpm --dir apps/web exec cf hyperdrive get \
  427dd7a2876c4dccbe056d37fa7374ff
```

Local `.env` and CI use `DATABASE_URL`. Deployed Worker code receives the
database URLs from Hyperdrive and does not need a `DATABASE_URL` secret.

### R2 and media domain

The main app uses the S3-compatible R2 endpoint for account
`9f10f078d35d86c78dedece2300a6b88`, bucket `foo`, key prefix `cubby`, and
public origin `https://media.nickysemenza.com`. The R2 access-key pair is scoped
for that bucket and stored only as Worker secrets.

USDA releases live in a second bucket, `cubby-usda-releases`, read through the
main Worker's native R2 binding `USDA_RELEASES`. Each release is a `YYYY-MM/`
prefix of gzipped NDJSON shards and a `manifest.json`; the release Durable
Object copies the active one into its own SQLite storage. Publishing a release
is in [development](development.md).

Cloudflare DNS and the R2 custom-domain configuration must route
`media.nickysemenza.com` to the main bucket. Image delivery depends on
Cloudflare Image Resizing at that origin.

### Secrets and plaintext variables

Set deployed Worker secrets interactively so their values do not enter shell
history:

```bash
pnpm --dir apps/web exec wrangler secret put NAME --name cubby
pnpm --dir apps/web exec cf workers secrets list --worker cubby
```

| Name                   | Storage                        | Purpose                                                       |
| ---------------------- | ------------------------------ | ------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | `cubby` Worker secret          | Better Auth signing/encryption                                |
| `R2_ACCESS_KEY_ID`     | `cubby` Worker secret          | Main R2 S3 credential                                         |
| `R2_SECRET_ACCESS_KEY` | `cubby` Worker secret          | Main R2 S3 credential                                         |
| `GOOGLE_CLIENT_SECRET` | `cubby` Worker secret          | Google OAuth confidential credential                          |
| `GOOGLE_CLIENT_ID`     | Checked-in Worker `vars` value | Public Google OAuth client identifier                         |
| `APNS_KEY_ID`          | `cubby` Worker secret          | APNs token-auth key id (photo-run Live Activities and alerts) |
| `APNS_TEAM_ID`         | `cubby` Worker secret          | Apple Developer team id that owns the APNs key                |
| `APNS_PRIVATE_KEY`     | `cubby` Worker secret          | APNs `.p8` PKCS8 PEM; absent = pushes recorded unsent         |
| `AI_GATEWAY_API_KEY`   | Worker/local secret            | Authenticated REST inference, including named subscriber BYOK |
| `NOTION_API_KEY`       | Optional Worker/local secret   | Optional Notion integration                                   |

OAuth client IDs, Cloudflare account IDs, resource IDs, public origins, and
Sentry DSNs are identifiers, not credentials. They may be committed. OAuth
client secrets, R2 secret keys, auth secrets, API tokens, and provider keys must
not be committed.

Photo import alert topics follow the registering build's canonical app identity,
including the separate Mac development bundle. Live Activity registrations use
the production Cubby app identity. Enable Push Notifications on each App ID and
refresh its signing profiles before validating delivery; configuring an APNs
key alone does not add the signed-client entitlement.
Delivery results apply only while the token, app identity and APNs environment
still match the registration that sent them. Correcting any of these resets
delivery state and prevents a late response from ending the corrected registration.
Alert delivery keys also include the cumulative planned photo count, so a late
response from an earlier batch cannot end a later batch in the same phase.

## Google Cloud and Gmail OAuth

Project:

- Name: `cubby`
- Project ID: `cubby-481519`
- Project number: `183601884678`

The production dependency is intentionally small:

1. `gmail.googleapis.com` is enabled.
2. Google Auth Platform has an External application named `Cubby`.
3. Data Access includes
   `https://www.googleapis.com/auth/gmail.readonly`.
4. A Web application OAuth client named `Cubby production` has:
   - Authorized JavaScript origin `https://cubby.nickysemenza.com`
   - Authorized redirect URI
     `https://cubby.nickysemenza.com/api/auth/callback/google`
5. Its client ID is committed in `apps/web/cloudflare.config.ts` as
   `GOOGLE_CLIENT_ID`; its client secret is stored in the `cubby` Worker.

Enable and verify the API with `gcloud`:

```bash
gcloud services enable gmail.googleapis.com --project=cubby-481519
gcloud services list --enabled --project=cubby-481519 \
  --filter='config.name:gmail.googleapis.com' \
  --format='value(config.name)'
```

The standard `gcloud` CLI does not create general Google Auth Platform OAuth
clients. Configure the consent screen and client in the
[Google Auth Platform console](https://console.cloud.google.com/auth/overview?project=cubby-481519).
The redirect URI is exact, including scheme and absence of a trailing slash.

For initial validation, an External app may remain in Testing with household
Google accounts listed as test users. Google expires Testing-mode grants after
seven days, so unattended hourly Gmail discovery requires publishing the app
to Production. A private personal-use app may remain unverified and display
Google's warning; do not expand its audience without revisiting Google's
restricted-scope verification and data-handling requirements.

Better Auth stores the resulting per-member access and refresh tokens encrypted
in its `account` table. Cubby requests read-only Gmail access and does not store
Google passwords.

Google sign-in on the web and Apple apps uses this same OAuth client and
requires the Gmail read-only grant. It only signs in existing Cubby users:
verified Google email can link to the matching existing household account,
but Google cannot create a new user. Password login remains available and
public signup remains closed. Reconnecting Google from Settings renews Gmail
consent; disconnecting Google removes both Google login and Gmail access.

The Apple apps use `ASWebAuthenticationSession` with `/auth/native`, backed by
the server and browser-proxy exports of `@better-auth/electron` (no Electron
runtime). The `cubby-native` client uses PKCE and the existing
`cubby://auth/callback` scheme. Its single-use code is exchanged at
`/api/auth/electron/token`; native clients persist the signed `set-auth-token`
header, never the raw token in the JSON response. Both password and Google
login use the same Keychain/session completion. This reuses the production
Google callback above; it does not require separate iOS or macOS OAuth clients.
Local and preview environments retain password login.

## AI providers

All billed application, Tester Army, live-evaluation, and integration-enabled
development calls use gateway `cubby`. Production uses the Workers AI Gateway
binding: `AI.run` with an explicit gateway for Workers AI models, and
`AI.gateway("cubby").run` for managed providers. Named subscriber-credit BYOK
uses native authenticated passthrough instead; see setup below. Tools outside Workers use
explicitly authenticated REST requests. Workers AI REST calls use the account
`/ai/run` endpoint with gateway routing, metadata, caching, and timeout controls
in `cf-aig-*` headers (not body options), avoiding a nested
unscoped provider call.
Every REST request names the gateway explicitly so it cannot create `default`:
the first authenticated request without a gateway ID recreates `default` even
after it is deleted
([manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/#default-gateway)).

Gateway metadata has three stable dimensions: `environment` (`production`,
`ci`, or `development`), `feature`, and `operation`, with optional `entityKind`.
The outbound transport filters to that contract. Model/provider, input counts,
entity and run identifiers, document paths, chunks, revisions, and prompt
versions remain in application accounting or traces rather than gateway
metadata. Cloudflare saves only the first five metadata entries per request,
and a spend rule split by a high-cardinality key gives every value its own
budget ([custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/),
[spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)).
Cookbook metadata used for model pricing is read before outbound
filtering. Tester Army preserves application feature/operation attribution,
sets its own environment, and always bypasses gateway caching because the
documented cache key does not include the gateway or metadata, so shared-gateway
traffic can return another environment's cached response
([caching](https://developers.cloudflare.com/ai-gateway/features/caching/#how-the-cache-key-works)).

All environments use `cubby`; `environment` metadata separates their logs and spend rules.
The shared gateway also shares Cloudflare's Unified Billing allowance of
200 requests per 60 seconds. The egress DO admits a rolling 180 starts/minute
and at most 64 in-flight requests in the `unified` bucket, covering Workers AI
and paid managed-provider calls. The 20-request margin leaves room for clients
outside the Worker. 64 is an operating safety bound, over twice the concurrency
needed at ten-second latency, not a published provider concurrency limit.
[AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
exclude BYOK from that rate limit. [Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
publish 300 RPM for ordinary text generation and 2,000 RPM for classification;
models requiring the Paid plan instead have per-model 20 RPM standard / 50 RPM
prepaid limits. Clef is not a Paid-plan-only model. These docs publish no fixed
Workers AI concurrency ceiling. Provider 429s and `Retry-After` remain authoritative.

The `subscriber-credit:anthropic` BYOK bucket has independent permits and
cooldowns, with no invented universal concurrency cap: Anthropic's
[limits](https://platform.claude.com/docs/en/api/rate-limits) depend on the
organization, model, requests and tokens. Its refusal/probe rules below remain.
The ChatGPT subscription transport bypasses AI Gateway and publishes
[plan-dependent usage limits](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan),
not a fixed RPM/concurrency allowance; it has no local model fan-out cap and is
not charged to the unified bucket. A full unified bucket never consumes credit
capacity. Subscriber-credit 429s cool only their bucket; unified 429s retain a
shared cooldown because their provider limit scope is unknown. A spend limit
can filter by `environment`, but cannot separate the shared request allowance.
Gateways are not a security boundary: AI Gateway tokens are
account-scoped, so any `Run` token reaches every gateway and its stored BYOK keys
([authenticated gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).
Dynamic routes accept only the OpenAI chat-completions shape, so Anthropic
Messages calls cannot use them
([dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)).
Provider routing and model identifiers live in
`packages/shared/src/ai/models.ts`. The declarations supply the model IDs,
provider names, capabilities, role-specific schemas, and defaults for application
and tooling callers. Provider credentials or unified-billing
configuration are Cloudflare AI Gateway state; no provider key belongs in this
repository. Verify that every model in the checked-in registry is enabled in
the gateway before relying on a feature that selects it.

### Claude subscriber credits

Every tier-routed chat call uses subscriber credits first (Opus), then the
ChatGPT subscription transport (Sol), then paid Unified Billing (Sol);
`fundedChatAttempts` owns the ladder. The implementation
and model declarations own the model choices; [ADR 0017](adr/0017-subscription-funded-model-fallback.md#background-work-spends-within-window-budgets)
records when paid fallback is allowed. Fixed-model evaluations do not change model.

Background work (a Run whose lineage root was scheduled, discovered or
backfilled) draws each free rung only within its window budget: the Claude
credit's (default $1.50) and the ChatGPT plan's ($2, `PLAN_BUDGET_LIMIT_USD`),
both at standard cost, because the household shares both with its own use.
Past one, `beforeFreeRequest` returns a `cubby_credit_budget_reached` or
`cubby_plan_budget_reached` funding refusal and the ladder moves on; an
unladdered plan call skips the plan for its paid or subscription-required
path. Every Run then pays within the paid budget, and once that is spent
`paidRunPreflight` pauses the Run (`paused_auth`, `execution_limit`). The `AI_GATEWAY_EGRESS` Durable Object holds one
`fundingResumeAt` alarm at the window end. Before recovery it consumes that
wake into a persisted, generation-tagged in-flight record; recovery retries
retain that record and any newly requested window remains pending separately.
`resumeFundingPausedRuns` then redispatches paused agent imports and relaunches
paused Mail discovery, and the
nightly/app-open recovery calls it too. A member's `run_now_paid` control
event ("Run now, paid allowed" on the Run page, "Run discovery now, paid
allowed" on the Mail import card, or MCP `run.lifecycle`/`run.discover_mail`)
resumes that Run now and lets it and the imports its discovery starts pay past
the paid budget by the confirmed `paidOverBudgetUsd` for the granting window.
The free-rung preflight (`freeRunPreflight`) recognizes a chat call by endpoint
path: pi-ai's Anthropic SDK posts `v1/messages?beta=true`.

A provider credit refusal is held, not retried. When a credit response is a
funding refusal `isInferenceFundingRefusal` recognizes (a Console spend limit,
a spent balance; never Cubby's own `cubby_credit_budget_reached`), the
`AI_GATEWAY_EGRESS` Durable Object records it with the raw body until the date
Anthropic names ("You will regain access on …"), else the end of the current
six-hour window. While it holds, credit admission answers at once with a
`cubby_credit_refused` 400 carrying that raw reason and makes no upstream call,
so every ladder moves straight to the ChatGPT plan; unified (paid) traffic is
unaffected. One credit request per window passes as a probe: success clears
the refusal, another refusal records it again. "Retry Claude credit now"
(Settings → AI funding, MCP `ai_funding.reset_credit_refusal`) and any credit
budget change clear it and resume funding-paused Runs. `ai_funding_read.status`
and the AI funding card report it as `credit.state` `refused`, with `until` and
`reason`. Refusals that arrive only inside a stream are not recorded.

1. Link the eligible Claude plan to the intended Anthropic Console organization.
2. Create a dedicated Cubby workspace with a monthly spend limit no larger than
   the included allowance, then create an API key in that workspace. Keys draw
   from the organization's shared credit balance; existing purchased credits and
   auto-reload can otherwise keep the key usable after promotional exhaustion.
3. In Cloudflare **AI → AI Gateway → cubby → Provider Keys**, add the Anthropic
   key with alias **subscriber-credit**. Never put it in repository files, CI,
   application environment variables or chat. Leave the **default** Anthropic
   BYOK key unset; unaliased requests must be able to use paid Unified Billing.
4. Keep Unified Billing enabled and Require provider credentials disabled for
   the final paid route. Credit requests explicitly send the named alias and
   `cf-aig-no-wholesale: true`; a missing or invalid key fails with raw setup
   diagnostics rather than silently spending paid credits.

Named BYOK uses the native Anthropic endpoint: Universal `gateway.run()` does
not honor the alias in its payload. The Worker authenticates native passthrough
with its `AI_GATEWAY_API_KEY` secret (a Cloudflare inference token, not the
Anthropic key). Reuse the existing Worker secret; deploying this feature does
not provision or overwrite it from a GitHub Actions token. Use the [secret listing command](#secrets-and-plaintext-variables) before
adding provisioning changes.
Managed paid calls retain the binding. Missing native authentication fails with an explicit diagnostic.

Console spend limits reset on the first of the calendar month, while promotional
credits refresh on the subscription billing cycle. A workspace cap is therefore
not an exact promotional-balance detector: an organization with purchased
credits may spend those before its cap. Console Billing owns the actual balance
and expiry; do not infer them from Cubby's usage totals. The retired
`cubby-testing` gateway can be removed after older deployments and local
processes stop using it; deleting it does not update those callers. Requests
that omit gateway scoping can recreate Cloudflare's `default` gateway.

### Pricing and transport

AI catalog/pricing implementation is owned by
`packages/shared/src/ai/pricing.ts`; runtime model defaults by
`packages/shared/src/ai/models.ts` and feature tiers by
`apps/web/src/server/ai/policy/features.ts`. Pricing belongs to accounting, outside
inference. Unavailable prices stay unknown; failed calls without reported usage
are unpriced, and token evidence is not a second SDK cost estimate.

The shared transport owns request controls, response headers, Universal gateway
calls, and the choice between test peers, ChatGPT, and billed gateway calls.
ChatGPT selection fails closed if that transport fails. Chat, decision,
embedding, cookbook, and native recovery calls retain their protocol-specific
payloads and retry policies. Gateway cache verdicts describe upstream billing;
application `cacheStatus` continues to describe the caller's own cache.

Decision assignment, caching, request bounds and response envelopes belong to
the shared decision runner. Independent all-or-fail decisions use
`runDecisionChoices`; callers retaining partial answers use the generic
`settleDecisionChoices(items, questionFor)`, whose outcomes carry their original
typed work item. Its cooperative option owns the Workflow's yield scope. Both wait for every started request before returning, including
when a sibling fails. Callers do not maintain parallel question-index arrays.
Cache hits retain their individual keys, while owned cache misses share requests
only within the same feature, sampled model, usage context, and embedded image
content. Shared images are sent once per batch; different media and text-only
questions stay in separate requests. Batches carry at most 64 independently
scoped questions and stay within the runner's serialized text budget; larger
sets split without dropping candidates. Waiting on another request's cache lease
does not hold up owned misses. Each upstream batch records usage once and still
passes through gateway egress admission. Dependent decision phases wait for their
required answers before starting another batch.
Product identity grounding batches source-literal questions before eligible
relation questions; usage is attributed to the literal or relation phase, while
individual dimension prompts, source literals, and fingerprints stay in receipts.
Application feature tiers are declared in
`apps/web/src/server/ai/policy/features.ts`; retier only with live-eval evidence or an
explicit member choice. Small ceiling-scoring evals cannot establish parity.
The opt-in feature eval uses production prompts, schema, validation and repair
turns, scores synthetic cases, and saves revision/replay/results under
`artifacts/feature-routing-eval/`. Its package script and environment options
own the replay command. Mail import still needs controlled model comparison
([backlog](https://github.com/nickysemenza/cubby/issues/2151)).

Image composition and identity-scope questions share a batch before dependent
category and catalog work. Image decisions route to vision-capable Clef independently of the text-only Jev
trial. Photo identification prepares renditions before the shared adapter
checks embedded media and uses the existing gateway, retry, cache and usage
paths. Media limits and payloads belong to `server/ai/decision-model.ts` and
`server/domains/image/service/image-identification.service.ts`.

Image description consumers select confirmed corrections first, then the current
preferred cloud result, then the newest available source-matching observation.
A newer Apple observation does not displace a preferred cloud description;
observations for replaced image content are historical evidence only.

Identification retains visual composition separately from identity scope.
Multiple related views, parts, or life stages may support one catalog identity;
unrelated objects, documents and uncertain scenes abstain from single-identity
matching. Suggestions remain unconfirmed and never change inventory or identity
automatically. Prompt/schema revisions fence reuse; historical observations are
retained rather than rewritten.

Clef classifies composition, selects a category, shortlists bounded catalog
candidates, then compares the source rendition with at most three
independently attached Product references. A source image never matches itself
by id or content hash, and a borrowed gallery image is not independent
evidence. Candidate names are hints; a search over a truncated roster reports
the truncation and is never presented as exhaustive, and option probabilities
are not calibrated confidence. Matching the same Product does not establish
that two photos show the same possession. Member corrections take precedence;
later machine evidence may flag a confirmed match for review but cannot replace
it. Reads never start inference, and retained results for deleted targets or
changed source content are filtered out. AVIF sources wait, without consuming
attempts, for the normalization job's verified JPEG snapshot.

An available Apple companion claims compatible waiting image jobs immediately
when it connects. The queue's no-device cooldown does not delay that claim;
pending retries still honor backoff. A job the device claimed but could not
take (refused assignment, failed command preparation) returns to `pending`
with that backoff, so the same device cannot reclaim it on its next pull.
Device participation and advertised image capabilities both gate execution.
Retryable failures, failed hand-offs and expired executor leases since the last
operator retry spend one budget (`IMAGE_PROCESSING_MAX_ATTEMPTS`); the failure
that exhausts it leaves the job `failed` with its last error. An operator retry
restores the full budget. The claim and retry policy belongs to
`server/domains/image-processing/repo/image-processing.ts`.

Cloud image execution uses `cubby-image-cloud`, separate from
`cubby-background`. Shared image wakeups await durable queue acceptance before
acknowledging and leave the existing job pending; only the destination claims
the source-matching attempt. A failed publication is retried by the shared
consumer, and existing image dispatch repair republishes pending or expired
jobs. The image job and its attempt history remain the only execution ledger.
Queue redelivery cannot create a second active attempt, and a caught provider
failure persists the job retry/backoff before acknowledging its delivery;
transport retries do not independently multiply paid calls.
Companion normalization results that require cloud description use the same
cloud lane; Apple execution and its capability/participation policy remain
owned by the companion transport.

The cloud lane accepts one image per invocation and bounds concurrency at four,
before download or claim. The shared consumer remains bounded at two, so those
two lanes can hold at most six Worker-side database clients; interactive work,
other queues and Workflows also share the Hyperdrive origin pool. Gateway
admission separately bounds paid model starts. These limits do not increase the
old shared batch size: ten tasks in one invocation previously exhausted Worker
memory. JPEG analysis reads are bounded before buffering: description and
companion normalization at 4 MiB, identification at 2 MiB. Four overlapping
description invocations hold at most 16 MiB of retained rendition bytes, with
additional bounded streaming, inspection and upload copies; this is a payload
bound, not a measurement of total isolate memory. Originals remain unchanged
when an oversized rendition fails with its raw size diagnostic.

Both shared and cloud consumers log `queue_wait_ms` from Cloudflare's transport
enqueue timestamp at consumer entry, with the queue name. Local delivery
adapters preserve that metadata; older fixture messages without it report an
unavailable wait rather than inventing one. Cloud logs separately retain
`intent_age_ms` from the job's persisted creation time, which includes shared
queue, device, normalization and retry/backoff delays. `execution_ms` measures
destination claim, preparation, provider work and adoption. Retried jobs retain
their original intent age.

Apple subject lift is independent of cloud cutout eligibility and attachment
purpose. Supported images reach Apple, which reports a cutout, no foreground
subject, an already-transparent input, or an unsupported format. The cloud
classification remains descriptive evidence, not a dispatch gate. A processor
revision change lets previously policy-skipped images be queued again without
rewriting their retained history.

Field decision prompts are measured from a Claude/Codex session over Cubby
MCP, following `.agents/skills/decision-grading`: reviewed Suggestions
(`entity_read.suggestion_queue` with `status`) are the labels, and
`entity_read.suggest_fields` with `decisionModel` replays a record through
Jev or Clef server-side. Only aggregates leave the session.

The `AI_GATEWAY_API_KEY` environment variable authenticates the direct REST
fallback used outside Cloudflare Workers. It is optional in the deployed Worker
because the `AI` binding supplies Worker-identity authentication.

## Observability

The web/Workers Sentry DSN is intentionally public and defined exactly once,
in `packages/worker-tracing/src/sentry-dsn.ts`; the web client and Worker, the
dev-only Node preload, and every auxiliary Worker import it from there. The
native app uses a separate `cubby-apple` Sentry project. Authentication and
ownership for both projects remain provider-side state.

Cloudflare joins service-binding, JS RPC, and Durable Object subrequests into
one trace, so the run page's proxy into the purchase agent's Durable Object
appears in the request's trace in the Cloudflare dashboard. A queue delivery
starts a new trace in the consumer;
`run.id` on the consumer's job span is the join key back to the producer's job
spans. Trace context never propagates to services outside Cloudflare.

`withInvocationTrace` loads the native tracing runtime before looking up the
active invocation span, then annotates that span and creates a timing child.
Fetch handlers, queue batches (including the purchase-agent consumer), scheduled maintenance,
Durable Object alarms, purchase-agent dispatch RPCs, and search-index repair
workflow runs use this entry helper, so a fresh isolate needs no preceding fetch.
Batch spans carry queue name and size; individual messages retain their own run
context instead of assigning one actor or run to an entire batch. Cron spans
include the trigger and scheduled time, including maintenance-mode skips.
Alarm and workflow spans identify their workload; purchase-agent alarm/RPC
spans also identify the Run. Entry annotation never ends the platform-owned
span. Other code uses `withTrace` for child operations and
`annotateActiveSpan` for an already initialized active span. Outside the Worker
build these helpers run work without tracing.

Authenticated Start, workflow-stream, HTTP and MCP failures follow the
[raw diagnostic contract](../AGENTS.md#product-constraints). Only credential-shaped
values are redacted. Request-scoped reporting captures the original exception
and supplies correlation/Sentry references; a capture ID is an attempt, not
proof of ingestion, and MCP batch items retain separate references.

Web error details include Copy details, the Sentry link, and Open Workers
Observability with a copyable Ray ID when Cloudflare supplied one. The Cloudflare
link opens the dashboard, not an individual trace: the custom-span API does not
expose the active trace ID. These references also survive native API decoding.

Source maps for `apps/web` are generated and uploaded at deploy by
`sentryTanstackStart` (`vite.config.ts`), under release `cubby@<short sha>` —
the same value the browser (`router.tsx`) and Worker (`worker-sentry.ts`) SDKs
report via `Sentry.init`/`withSentry`. The plugin does not inject the release
into chunks (`release.inject: false`): stamping the commit into every chunk
would change every client asset's content on every deploy, so each deploy would
re-upload them all. Client `.map` files are deleted from
the Build Output assets directory afterward so none are served as Worker static assets. Server
maps remain in the Build Output Worker bundle for diagnostics. The build removes sourcemap
entries from the native Build Output manifest so `cf deploy --prebuilt` does
not upload them again; the combined map exceeds Cloudflare's upload limit. Map sources are
rewritten to repo-relative paths (`apps/web/src/...`, `packages/*/src/...`) so
a single Sentry GitHub code mapping (repo root -> repo root on `main`) resolves
stack frames from both the client bundle and the Worker bundle. The upload needs a `SENTRY_AUTH_TOKEN`
secret, present only in the `deploy.yaml` workflow; PR/preview builds have no
token, so the plugin injects debug IDs and deletes client maps but skips the
network upload. `SENTRY_IGNORED_ERRORS` (`apps/web/src/lib/sentry-noise.ts`)
lists known-noise messages dropped via `ignoreErrors` before Sentry ingests
them, so they never consume the free-plan error quota.

The production Cloudflare configuration owns Workers Observability trace persistence
and sampling. Cloudflare is the only trace
destination; no Jaeger, Grafana Tempo, or Sentry trace exporter is configured.
Sentry continues to capture errors on web, Apple, and auxiliary Workers.

Worker logs also reference the account-level `grafana-logs` destination for
Grafana Cloud Loki. The calendar-test Worker is a local test harness and does
not export test traffic. Destination credentials live in Cloudflare, not GitHub
or this repository.

## GitHub and deployment

`main` is deployed by `.github/workflows/deploy.yaml`. The `cloudflare` GitHub
Environment scopes production deployment to `main`; deployment jobs own
serialization. Store `PRODUCTION_DIRECT_DATABASE_URL` only in this environment,
not as a repository secret. Required repository or environment secrets are:

| Secret                           | Purpose                                                     |
| -------------------------------- | ----------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`           | Deploy declared Workers and manage their bindings           |
| `PRODUCTION_DIRECT_DATABASE_URL` | Apply production migrations before deploying the web Worker |
| `CLAUDE_CODE_OAUTH_TOKEN`        | Automated Claude workflows, not application runtime         |

The Cloudflare token should be scoped to the checked-in account and only the
resource types the deployment workflow manages. Production deploys always
build before invoking `cf deploy --prebuilt --mode production`. Preview deploys are not supported; production
is the only deployed environment.

## Apple platform

The native targets use Xcode-managed signing and the associated domain
`cubby.nickysemenza.com`. The web Worker serves the Apple App Site Association
file. Purchase-import browser control additionally requires the checked-in
Apple Events entitlement and usage description; macOS grants Automation and
optional Screen Recording permission per local installation. Hosted release setup follows
[the Apple release guide](../apps/apple/README.md#testflight-releases).

## Reconstruction and drift check

For a new account or disaster recovery:

1. Restore PostgreSQL and R2 before accepting writes.
2. Recreate R2 bucket `cubby-usda-releases` and upload the active USDA release.
3. Recreate Hyperdrive, queues, Vectorize, AI Gateway/provider access, and
   observability destinations; update checked-in IDs if they changed.
4. Restore Worker and GitHub secrets through their providers.
5. Recreate Google Auth Platform configuration and rotate the Google client
   secret rather than copying it through documentation.
6. Deploy `cubby`; verify its exact source revision, that it is the only
   consumer of each of its queues (including `cubby-purchase-agent`), the
   `PURCHASE_IMPORT_RUN` agent namespace, Gateway usage, and run authenticated
   database, media, AI, Gmail, purchase-agent, and auxiliary-service smoke
   tests.
7. Reconnect native clients and regrant local macOS permissions.

Before deleting apparently unused provider state, search the repository, check
provider usage/audit logs, and confirm that it is absent from current deployed
bindings. A resource being absent from this file is evidence of drift, not by
itself authorization to delete it.

Suggestion sweep behavior belongs in [compiled entities](entities.md#product-classification-and-photos),
not the infrastructure reconstruction checklist.
