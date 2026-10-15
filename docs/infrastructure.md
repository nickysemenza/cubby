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

- [`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc)
- [`.github/workflows/deploy.yaml`](../.github/workflows/deploy.yaml)

## Cloudflare

Account ID: `9f10f078d35d86c78dedece2300a6b88`.

### Main Worker

[`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc) owns Worker bindings,
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

Retired executor purposes preserve recorded inputs/checkpoints but cannot resume.
Catch-up reconciles attempts that ended without finishing their Run. Discovery
readiness and usage reads remain storage-only; current cursor coverage is not a
snapshot of one historical Run and a read never grants execution.

One-time creation commands that cannot be inferred or safely rerun by deploy:

```bash
pnpm --dir apps/web exec wrangler queues create cubby-background
pnpm --dir apps/web exec wrangler queues create cubby-image-cloud
pnpm --dir apps/web exec wrangler queues create cubby-telemetry
pnpm --dir apps/web exec wrangler queues create cubby-purchase-agent
pnpm --dir apps/web exec wrangler vectorize create \
  cubby-openai-text-embedding-3-small-1536 \
  --dimensions=1536 --metric=cosine
pnpm --dir apps/web exec wrangler vectorize create-metadata-index \
  cubby-openai-text-embedding-3-small-1536 \
  --property-name=entityType --type=string
```

The Workflow, Durable Object namespaces, bindings, consumers, crons, and route
are created or updated by `wrangler deploy` from the checked-in configuration.

### Purchase agent

The purchase agent coordinates import runs inside Worker `cubby`: an Agents
SDK `Agent` hosting a pi-durable conversation through `PiHarness`. Its
checked-in configuration is part of `apps/web/wrangler.jsonc`:

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
  when it is the round's sole call.

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
separate. Startup lifecycle/progress modules import the
database helpers' `core` and `query` modules directly: the barrel also
initializes relation loaders and CRUD dependencies. These belong behind their
consuming handler; the entry budget does not measure the additional imports
an API operation or page needs.

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
(`wrangler queues consumer remove cubby-purchase-agent <worker>`); events wait
in the queue until the new consumer deploys.

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
0.25–4 CU. This range belongs to the production endpoint: changing the project's
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

The IDs are checked into `apps/web/wrangler.jsonc`; the origin connection
string and cache/connection-limit settings are provider-side state. Recreate
with a direct Neon URL, never a pooled URL:

```bash
pnpm --dir apps/web exec wrangler hyperdrive create cubby-db \
  --connection-string="postgres://REDACTED"
pnpm --dir apps/web exec wrangler hyperdrive create cubby-db-cached \
  --connection-string="postgres://REDACTED"
```

After recreation, update the checked-in IDs and reapply the connection limits
and cached binding policy. Inspect live state before deployment:

```bash
pnpm --dir apps/web exec wrangler hyperdrive get \
  adc9757dfffd45bc94d5c2a66b2ad410
pnpm --dir apps/web exec wrangler hyperdrive get \
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
pnpm --dir apps/web exec wrangler secret put NAME --config wrangler.jsonc
pnpm --dir apps/web exec wrangler secret list --config wrangler.jsonc
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
| `AI_GATEWAY_API_KEY`   | Local secret only              | REST fallback outside the production Workers AI binding       |
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
5. Its client ID is committed in `apps/web/wrangler.jsonc` as
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
`AI.gateway("cubby").run` for other providers. Tools outside Workers use
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

The shared gateway also shares Cloudflare's Unified Billing allowance of
200 requests per 60 seconds and its gateway-wide rate limit; this is an
accepted capacity tradeoff. A spend limit can filter by `environment` to budget
CI independently, but cannot separate that request allowance. Gateways are not
a security boundary: AI Gateway tokens are account-scoped, so any `Run` token
reaches every gateway and its stored BYOK keys
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

AI catalog/pricing implementation is owned by
`packages/shared/src/ai/pricing.ts`; runtime model defaults by
`packages/shared/src/ai/models.ts` and feature tiers by
`apps/web/src/server/ai/features.ts`. Pricing belongs to accounting, outside
inference. Unavailable prices stay unknown; failed calls without reported usage
are unpriced, and token evidence is not a second SDK cost estimate.

The shared transport owns request controls, response headers, Universal gateway
calls, and the choice between test peers, ChatGPT, and billed gateway calls.
ChatGPT selection fails closed if that transport fails. Chat, decision,
embedding, cookbook, and native recovery calls retain their protocol-specific
payloads and retry policies. Gateway cache verdicts describe upstream billing;
application `cacheStatus` continues to describe the caller's own cache.

Decision assignment, caching, request bounds and response envelopes belong to
the shared decision runner. Independent text decisions use `runDecisionChoices`:
cache hits retain their individual keys, while owned cache misses share requests
only within the same feature, sampled model, and usage context. Batches carry
at most 64 independently scoped questions and stay within the runner's serialized
text budget; larger sets split without dropping candidates. Waiting on another
request's cache lease does not hold up owned misses. Each upstream batch records
usage once and still passes through the gateway egress admission limits. Dependent
decision phases wait for their required answers before starting another batch.
Product identity grounding batches source-literal questions before eligible
relation questions; usage is attributed to the literal or relation phase, while
individual dimension prompts, source literals, and fingerprints stay in receipts.
Application feature tiers are declared in
`apps/web/src/server/ai/features.ts`; retier only with live-eval evidence or an
explicit member choice. Small ceiling-scoring evals cannot establish parity.
The opt-in feature eval uses production prompts, schema, validation and repair
turns, scores synthetic cases, and saves revision/replay/results under
`artifacts/feature-routing-eval/`. Its package script and environment options
own the replay command. Mail import still needs controlled model comparison
([backlog](todos.md#import-pipeline-architecture)).

Image decisions route to vision-capable Clef independently of the text-only Jev
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
pending retries still honor backoff. Device participation and advertised image
capabilities both gate execution. The claim policy belongs to
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
MCP, following `.claude/skills/decision-grading`: reviewed Suggestions
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
`dist/client/` afterward so none are served as Worker static assets. Server
maps remain in `dist/server/`: Cloudflare output can reference them with
`sourceMappingURL`, and Wrangler requires those files when deploying. Map sources are
rewritten to repo-relative paths (`apps/web/src/...`, `packages/*/src/...`) so
a single Sentry GitHub code mapping (repo root -> repo root on `main`) resolves
stack frames from both the client bundle and the Worker bundle. The upload needs a `SENTRY_AUTH_TOKEN`
secret, present only in the `deploy.yaml` workflow; PR/preview builds have no
token, so the plugin injects debug IDs and deletes client maps but skips the
network upload. `SENTRY_IGNORED_ERRORS` (`apps/web/src/lib/sentry-noise.ts`)
lists known-noise messages dropped via `ignoreErrors` before Sentry ingests
them, so they never consume the free-plan error quota.

Production Wrangler configuration owns Workers Observability trace persistence
and sampling. Cloudflare is the only trace
destination; no Jaeger, Grafana Tempo, or Sentry trace exporter is configured.
Sentry continues to capture errors on web, Apple, and auxiliary Workers.

Worker logs also reference the account-level `grafana-logs` destination for
Grafana Cloud Loki. The calendar-test Worker is a local test harness and does
not export test traffic. Destination credentials live in Cloudflare, not GitHub
or this repository.

## GitHub and deployment

`main` is deployed by `.github/workflows/deploy.yaml`. The `cloudflare` GitHub
Environment serializes and scopes production deployment. Required repository
or environment secrets are:

| Secret                    | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`    | Deploy declared Workers and manage their bindings   |
| `CLAUDE_CODE_OAUTH_TOKEN` | Automated Claude workflows, not application runtime |

The Cloudflare token should be scoped to the checked-in account and only the
resource types the deployment workflow manages. Production deploys always
build before invoking Wrangler. Preview deploys are not supported; production
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
