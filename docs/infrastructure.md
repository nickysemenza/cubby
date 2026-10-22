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
| Purchase-import orchestration | Agents SDK + pi-durable            | Worker `cubby`: `purchase.dispatch` Job, Durable Object `PurchaseImportRunAgent`         |
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
Durable Objects, queues, placement, asset routing, crons and plaintext
variables. Deploy creates/updates those resources. This page records provider
state and reconstruction constraints that configuration cannot reproduce.

Vectorize's string metadata index is named `entityType`: that provider-side
name predates `entityKind` and must remain when recreating the index.

### Durable Jobs and Runs

Postgres `Job` owns background execution, including Run pages, shared AI
evaluations, derived refresh and purchase dispatch. Admission and its Job intent
commit together. Run checkpoints, paid results, receipts and member decisions
remain in their domain records. [ADR 0015](adr/0015-unified-durable-work-coordination.md)
owns the execution contract; mailbox page and retention behavior lives in the
[purchase-import module guide](../apps/web/src/server/domains/purchase-import/service/README.md#mail-import-end-to-end).

`cubby-background` carries only the version-3 wake envelope. Every delivery,
including an unreadable envelope, attempts the same due-Job drain and is always
acknowledged. Transport has no retry budget. Lost wakes are recovered by the
minute cron and app-open catch-up. Telemetry has its separate queue.

One SQL window query interleaves due kinds, starting with the least recently
served kind derived from existing Job timestamps. Priority ranks only within a
kind; manual Run execution has raised priority. The drain reselects batches of
25 with a default 256-page / 20-second budget. Budget exhaustion publishes a
new wake. Claims use `SKIP LOCKED`, renewed leases and generation/token fences;
successful pages reset consecutive failures. Exhausted failures and member
pauses require explicit action.

Typed `waitReason` and `waitUntil` distinguish provider capacity, AI funding
windows, device availability and rate limiting from retry backoff. Claim,
successful ordinary publication and failure clear waits. Single-item Jobs
retain `subjectKind` / `subjectId` for diagnostics on their owning record.
`retry_wait` retains the raw scrubbed error and consecutive failure attempt of
`maxAttempts`. Application page sizes live in `JOB_PAGE_LIMITS`.

The minute cron publishes `ai-refresh.activate`, keyed by deployment version
and its observed occurrence. A transaction serializes occurrence admission,
checks the gateway DO's running version and fences activation to the recorded
occurrence. A rollback A → B → A receives a new occurrence and restarts automatic
discovery without replacing policy generations. Member automatic-rule controls
remain independent. No fetch observation, observation epoch alarm or funding
resume alarm schedules this work.

Purchase `purchase.dispatch` Jobs complete after the coordinator accepts a
stable operation identity. The coordinator owns conversation settlement and
its SDK lifecycle alarms. Acknowledged coordinators are never submitted again
by retrying a start Job. Funding pauses persist a `run.funding-resume` Job with
`ai_funding_window` and the window deadline; domain resumption regenerates
funding-paused purchase dispatches. Explicit budget increases can resume early;
manual pauses stay stopped.

Job claim/page/publish/defer/fail logs emit one JSON object with `runId`, `jobId`,
`kind`, `stepKey`, `generation`, `attempt` and `waitReason`. Workers Logs indexes
[structured JSON objects](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects);
raw errors retain their credential-scrubbed diagnostic detail.

One-time creation commands that cannot be inferred or safely rerun by deploy:

```bash
pnpm --dir apps/web exec cf queues create --queue-name cubby-background
pnpm --dir apps/web exec cf queues create --queue-name cubby-telemetry
pnpm --dir apps/web exec cf vectorize create \
  --name cubby-openai-text-embedding-3-small-1536 \
  --index-config-dimensions 1536 --index-config-metric cosine
pnpm --dir apps/web exec cf vectorize metadata-index create \
  cubby-openai-text-embedding-3-small-1536 \
  --property-name entityType --index-type string
```

The Durable Object namespaces, bindings, consumers, crons, and route
are created or updated by `cf deploy` from the checked-in configuration's Build Output.

### Purchase agent

The purchase agent coordinates import runs inside Worker `cubby`: an Agents
SDK `Agent` hosting a pi-durable conversation through `PiHarness`. It uses the
upstream lifecycle: a failed cached session requires explicit disposal or Durable
Object recreation before reopening; Cubby does not override the SDK's cache.
Its checked-in configuration is part of `apps/web/cloudflare.config.ts`:

- SQLite Durable Object class `PurchaseImportRunAgent` (binding
  `PURCHASE_IMPORT_RUN`), one instance named `import-run:<Run.id>` or
  `photo-inventory:<Run.id>` per run (`importRunAgentIdentity`); pi keeps the
  transcript, inbox, and tasks in the object's SQLite, and Lifecycle jobs wake
  it through its alarm after eviction;
- the `purchase.dispatch` Job handler, admitted in the Run transaction, which
  fences duplicate and late starts with the Run's dispatch generation and
  `coordinatorStartedAt`; stable operation IDs survive lost replies. Job owns
  bounded retries and raw terminal errors; the coordinator owns settlement.
  Cutover preserves `dispatchAttempts` in Run audit history before dropping it,
  backfills unacknowledged dispatch intent and preserves stopped failures;
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
  Run. The dispatch Job gets a separate environment that resolves any Run's
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
`server/domains/purchase-agent/service/run-agent.ts` on its first event, and the Job handler loads the dispatch host only when
a purchase dispatch is due
(`apps/web/tooling/checks/check-server-closure.ts` reports the static entry, browser
API bootstrap, combined page path, and total output). The API bootstrap includes
the dispatch adapter's static imports; individual operation loaders remain
separate. Startup lifecycle/progress/admission modules import the
database helpers' `core` and `query` modules directly: the barrel also
initializes relation loaders and CRUD dependencies. Refresh admission keeps its
slot query and lock in a lightweight module without AI policy, discovery or the
generated entity catalog. These belong behind their
consuming handler; the entry closure does not measure the additional imports
an API operation or page needs. Byte counts are informational, not CI limits:
a size threshold alone does not establish a startup or request-time regression.
The build still rejects leaked fixture code and Sentry build-time instrumentation.

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
deploy. Job dispatch intent remains in Postgres; coordinator SQLite receipts
and conversations must be preserved across the cutover.

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

Minute cron and app-open catch-up inspect Postgres Job intent and use the same
drain as background wakes. Stateful Durable Objects retain only their provider
admission, cache or coordinator responsibilities. AI refresh policy details
live in the [refresh runbook](runbooks/ai-refresh.md).

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
concurrency remains 1. Purchase dispatch starts coordinator work outside Job delivery; the background
queue cap does not bound active coordinator database work. That workload policy
remains separate.

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

| Name                   | Storage                        | Purpose                                                                                                                                                           |
| ---------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | `cubby` Worker secret          | Better Auth signing/encryption                                                                                                                                    |
| `R2_ACCESS_KEY_ID`     | `cubby` Worker secret          | Main R2 S3 credential                                                                                                                                             |
| `R2_SECRET_ACCESS_KEY` | `cubby` Worker secret          | Main R2 S3 credential                                                                                                                                             |
| `GOOGLE_CLIENT_SECRET` | `cubby` Worker secret          | Google OAuth confidential credential                                                                                                                              |
| `GOOGLE_CLIENT_ID`     | Checked-in Worker `vars` value | Public Google OAuth client identifier                                                                                                                             |
| `APNS_KEY_ID`          | `cubby` Worker secret          | APNs token-auth key id (photo-run Live Activities and alerts)                                                                                                     |
| `APNS_TEAM_ID`         | `cubby` Worker secret          | Apple Developer team id that owns the APNs key                                                                                                                    |
| `APNS_PRIVATE_KEY`     | `cubby` Worker secret          | APNs `.p8` PKCS8 PEM; absent = pushes recorded unsent                                                                                                             |
| `AI_GATEWAY_API_KEY`   | Worker/local secret            | Cloudflare API token: authenticated REST inference, including named subscriber BYOK; with account-scoped Workers Observability Edit it also reads inline Job logs |
| `NOTION_API_KEY`       | Optional Worker/local secret   | Optional Notion integration                                                                                                                                       |

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

All billed application, live-evaluation, and integration-enabled
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
filtering. The live-evaluation gateway peer
(`apps/web/tooling/ai/live-gateway.ts`) preserves application feature/operation attribution,
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
`paidRunPreflight` pauses the Run (`paused_auth`, `execution_limit`). The funding pause transaction records a `run.funding-resume` Job due just after
the window end, with `waitReason=ai_funding_window` and `waitUntil`.
`resumeFundingPausedRuns` redispatches eligible agent imports and resumes paused
Mail discovery; nightly/app-open recovery calls the same domain path. A member's `run_now_paid` control
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
typed work item. Its cooperative option owns the Job's yield scope. Both wait for every started request before returning, including
when a sibling fails. Callers do not maintain parallel question-index arrays.
Cache hits retain their individual keys, while owned cache misses share requests
only within the same feature, selected model, usage context, and embedded image
content. Shared images are sent once per batch; different media and text-only
questions stay in separate requests. Batches carry at most 64 independently
scoped questions and stay within the runner's serialized text budget; larger
sets split without dropping candidates. Waiting on another request's cache lease
does not hold up owned misses. Each upstream batch records usage once and still
passes through gateway egress admission. Dependent decision phases wait for their
required answers before starting another batch.
Finite collections that must prepare evidence or perform dependent choices use
`settleDecisionWorkItems`. It bounds preparation, releases preparation slots
while questions wait, and submits compatible cache misses in waves. Each
question retains its originating input-capture context; each work item retains
its own usage attribution and outcome. Use a shared usage object only when
the collection has one attribution owner. Mail attachments prepare their email
evidence once; image provenance freezes its roster and rejects failed decisions
before publication. USDA and ingredient-merge batches retain per-ingredient
errors; UPC offer judgments share one request context inside each lookup, while
the outer UPC loop retains quota and rate-limit stopping behavior.
Paired field audits record `AssessmentState.data.served` explicitly. List
filters and the immutable Assessment publication trigger use that flag;
ordinary field answers are served by default. Paired publications without a
boolean flag fail. The cutover migration materializes existing serving and
checkpoint metadata before deleting retired automatic routing pins from Run
inputs and evaluation snapshots. Immutable model attribution remains intact.
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
when it connects. The Job's no-device cooldown does not delay that claim;
pending retries still honor backoff. A job the device claimed but could not
take (refused assignment, failed command preparation) returns to `pending`
with that backoff, so the same device cannot reclaim it on its next pull.
Device participation and advertised image capabilities both gate execution.
Retryable failures, failed hand-offs and expired executor leases since the last
operator retry spend one budget (`IMAGE_PROCESSING_MAX_ATTEMPTS`); the failure
that exhausts it leaves the job `failed` with its last error. An operator retry
restores the full budget. The claim and retry policy belongs to
`server/domains/image-processing/repo/image-processing.ts`.

Cloud and native image execution share one Job lease and generation fence.
The background drain dispatches cloud work; a compatible native pull can claim
a device-waiting Job before its cooldown. Processing attempts preserve executor
attribution and output receipts; late completions cannot adopt after ownership
expires. Job failures use the same retry budget as other background work.
The background consumer remains bounded at two concurrent deliveries; provider
admission separately bounds paid model starts. These limits do not reserve
interactive Hyperdrive connections. JPEG analysis reads are bounded before buffering: description and
companion normalization at 4 MiB, identification at 2 MiB. Four overlapping
description invocations hold at most 16 MiB of retained rendition bytes, with
additional bounded streaming, inspection and upload copies; this is a payload
bound, not a measurement of total isolate memory. Originals remain unchanged
when an oversized rendition fails with its raw size diagnostic.

The background consumer logs `queue_wait_ms` from Cloudflare's transport
enqueue timestamp at consumer entry, with the queue name. Local delivery
adapters preserve that metadata; older fixture messages without it report an
unavailable wait rather than inventing one. Image logs separately retain
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

### Inline Job logs and limits

A Run's Diagnostics section and an Image's or Location's Jobs slot read one
Job's raw Worker lines through `job.logs`
(`server/generic/jobs/service/job-logs.ts`). It calls the Workers
Observability telemetry query API, `POST /accounts/{account}/workers/observability/telemetry/query`.

- **Filter.** `jobId` OR `runId` (the top-level fields `@cubby/worker-tracing`
  logs), view `events`, at most 500 lines.
- **Window.** The Job's active window, with a minute of margin either side.
- **Credentials.** The query authenticates with the `AI_GATEWAY_API_KEY`
  Worker secret. That Cloudflare API token must also carry the account-scoped
  Workers Observability Edit permission: the telemetry query endpoint requires
  Write even for reads.
- **Missing token.** Without `AI_GATEWAY_API_KEY` the panel reads "not
  configured". A token without the permission returns 401/403, which the panel
  shows as the scrubbed raw error. A local run with the key queries the
  account's logs, which hold no local Job lines.
- **Retention.** A window older than Workers Logs' 7-day retention reads
  "raw logs expired".
- **Failures.** A failed query shows its raw response, redacted only by
  `scrubErrorMessage`, with Retry and the dashboard link.

`server/generic/jobs/limits-catalog.ts` lists every limit that can set a Run's
speed, imported from the constant or config that enforces it:

- queue consumers;
- drain pages, time and batch;
- lease and heartbeat;
- attempts and backoff;
- step page caps and in-page preparation and publication concurrency;
- AI Gateway in-flight, rate and deadline;
- AI refresh slots;
- the funding window;
- provider retry wait;
- database connections.

Change a value at its source, never in the catalog.

`evaluateBinding` names the limit binding now:

- **Typed Job waits.** A wait (`provider_capacity`, `ai_funding_window`,
  `rate_limit`, `device`) and a retry backoff each name their limit.
- **Due Jobs.** A due Job is held by drain capacity, counted with its same-kind
  Jobs ahead.
- **Running pages.** A running step reads its last page sample (`RunStep.meta.page`):
  - a page near the drain budget is cut by it;
  - a phase whose peak in-flight work reaches its cap is "concurrency N of N
    busy";
  - otherwise the page's own work sets the pace ("preparation 61% of page time
    · 106 queries/page").
- **No sample.** Without a sample the verdict is "Unknown — no recent samples".

Step pages record their own sample through `measurePage`
(`server/generic/jobs/page-work.ts`). Executed steps get it as
`StepPageContext.work`; routine passes are measured by `routineStepHandler`
(selection, then publication).

- **Phases.** A driver times a phase with `work.time` or adds the timings its
  repository already measured with `work.add`. Statement generation passes the
  same selection, preparation, publication and application times it logs.
- **Concurrency.** Peaks are `min(cap, items)`, the workers
  `forEachConcurrently` starts.
- **Queries.** The page runs inside `withDatabaseOperationMetrics`, so
  `queries` counts the traced pool's statements. Zero counted means the page ran
  outside the traced pool and stores null ("not measured").
- **Unmeasured drivers.** A page that records no phase stores no sample.

### Error tracking and traces

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
Fetch handlers, queue batches, scheduled maintenance,
Durable Object alarms, purchase-agent dispatch RPCs, and search-index repair
Jobs use this entry helper, so a fresh isolate needs no preceding fetch.
Batch spans carry queue name and size; individual messages retain their own run
context instead of assigning one actor or run to an entire batch. Cron spans
include the trigger and scheduled time, including maintenance-mode skips.
Alarm and Job spans identify their workload; purchase-agent alarm/RPC
spans also identify the Run. Entry annotation never ends the platform-owned
span. Other code uses `withTrace` for child operations and
`annotateActiveSpan` for an already initialized active span. Outside the Worker
build these helpers run work without tracing.

Authenticated Start, workflow-stream, HTTP and MCP failures follow the
[raw diagnostic contract](agents/domain-rules.md#error-diagnostics). Only credential-shaped
values are redacted. Request-scoped reporting captures the original exception
and supplies correlation/Sentry references; a capture ID is an attempt, not
proof of ingestion, and MCP batch items retain separate references.

Authenticated diagnostics retain complete messages, stacks, SQL and parameters,
upstream response bodies, and all distinct causes, with cycle detection rather
than arbitrary character or cause-count limits. Error classification can still
bound its search; classification limits must not truncate the displayed evidence.
Credential scrubbing also decodes JSON property names and embedded JSON strings,
including escaped quotes, before preserving their diagnostic content.
The browser distinguishes an HTTP failure from an application error: HTTP
diagnostics retain status, URL, content type, body (including an explicitly empty
body), elapsed time, and available request/Ray/Sentry references. An empty
platform response cannot supply the underlying Worker exception; do not invent
one or replace it with an application `INTERNAL_SERVER_ERROR`. Response bodies
and stacks render as inert text, and Copy details carries the same complete
evidence. Terminal query failures retain earlier retry/fallback evidence.

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
The web build excludes Sentry tracing and SDK debug statements through the
upstream bundler options; error capture, raw application diagnostics, and source
maps remain enabled.

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
   consumer of each of its queues (background wakes and telemetry), the
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
