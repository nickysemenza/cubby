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
| PostgreSQL                    | Neon through Cloudflare Hyperdrive | One Neon origin, three Hyperdrive configurations                                         |
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

[`apps/web/cloudflare.config.ts`](../apps/web/cloudflare.config.ts) owns Worker
bindings, Durable Objects, queues, placement, asset routing, crons and plaintext
variables. Deploy creates/updates those resources. This page records provider
state and reconstruction constraints that configuration cannot reproduce.

Vectorize's string metadata index is named `entityType`: that provider-side
name predates `entityKind` and must remain when recreating the index.

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

The Durable Object namespaces, bindings, consumers, crons and route are created
or updated by `cf deploy` from the checked-in configuration's Build Output.

### Background work

Postgres `Job` and the drains' own rows own background execution;
[Durable Jobs](jobs.md) owns the runtime contract and
[ADR 0015](adr/0015-unified-durable-work-coordination.md) the coordination
decision. The infrastructure it depends on:

- `cubby-background` carries only the permit envelope. Every delivery,
  including an unreadable envelope, is one permit to run one unit and is
  acknowledged whatever the unit's outcome; failures before or around selection
  retry delivery up to three times
  ([selection and admission](jobs.md#selection-and-admission)).
- Telemetry has its separate `cubby-telemetry` queue.
- One hourly cron trigger is the timer and backstop for every permit
  ([deadline scheduling](jobs.md#deadline-scheduling-and-idle-recovery)).

### Worker startup

The agent runtime (Agents SDK, pi-durable, MCP client) stays off every page
request: the exported Durable Object is a shell that loads
`server/domains/purchase-agent/service/run-agent.ts` on its first event, and the
Job handler loads the dispatch host only when a purchase dispatch is due.
`apps/web/tooling/checks/check-server-closure.ts` reports the static entry,
browser API bootstrap, combined page path and total output; the API bootstrap
includes the dispatch adapter's static imports, while individual operation
loaders stay separate. Startup lifecycle/progress/admission modules import the
database helpers' `core` and `query` modules directly, because the barrel also
initializes relation loaders and CRUD dependencies. Refresh admission keeps its
slot query and lock in a lightweight module without AI policy, discovery or the
generated entity catalog. Byte counts are informational, not CI limits: a size
threshold alone does not establish a startup or request-time regression. The
build still rejects leaked fixture code and Sentry build-time instrumentation.

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

### Purchase agent

The purchase agent coordinates import Runs inside Worker `cubby`. Its
checked-in configuration in `apps/web/cloudflare.config.ts` is the SQLite
Durable Object class `PurchaseImportRunAgent` (binding `PURCHASE_IMPORT_RUN`,
one instance per Run), the SQLite Durable Object class
`CoordinatorGateDurableObject` (binding `COORDINATOR_GATE`, one instance named
`household`) that queues their work turns
([budget](#background-connection-budget)), and the `purchase.dispatch` Job
handler. Runtime
behavior, model context, observation and the agent's **trust boundary** (no
`env`, Run-bound services, delegated MCP, the `cubby/purchase-agent-boundary`
lint rule) are in the
[purchase-import module guide](../apps/web/src/server/domains/purchase-import/service/README.md#purchase-agent).

The fixed public OAuth client id is `cubby-purchase-agent`. It uses
authorization code + PKCE, `offline_access`, no client secret, and the callback
`https://cubby.nickysemenza.com/api/import/agent/oauth/callback`. The web Worker
provisions the client idempotently when authorization begins. Better Auth's
`oauth_refresh_token` row is the revocable grant; its value is never copied to
the agent. The web Worker mints five-minute, Run-bound delegation tokens for MCP
calls and rechecks the live grant and Run ownership on every request.

Pi-durable conversations live in the coordinator's Durable Object, so moving
the class between Workers or replacing it does not carry them over: terminate
the Runs whose coordinator is active (`running` and `paused_*`) before such a
deploy. Job dispatch intent remains in Postgres; coordinator SQLite receipts and
conversations must be preserved across that change.

Each member authorizes once from Settings. Verify the client/grant without
printing token values:

```sql
SELECT c.client_id, c.token_endpoint_auth_method, c.require_pkce,
  count(r.id) AS active_grants
FROM oauth_client c
LEFT JOIN oauth_refresh_token r
  ON r.client_id = c.client_id AND r.revoked IS NULL
WHERE c.client_id = 'cubby-purchase-agent'
GROUP BY c.client_id, c.token_endpoint_auth_method, c.require_pkce;
```

### PostgreSQL and Hyperdrive

Neon owns the PostgreSQL database. Production compute is autoscaling 0.25–2 CU
(`max_connections` 901) and keeps scale-to-zero (300 s idle) by choice: the
first query after an idle gap waits for compute start (about 0.5 s median,
0.9 s p90), visible as a long `db.connect.phase.startup` on `db.client.connect`.
This range belongs to the production endpoint: changing the project's default
compute range does not resize an existing endpoint.

The Hyperdrive origin connection caps are 40 strong + 12 cached + 40
background. All three configurations share origin compute; the cached pool needs
headroom for short reads while expensive reads are running. Pool caps are soft
limits, not interactive connection reservations. Keep them below database
capacity and measure origin waits and query execution together before raising
them; more connections cannot remove expensive query work. Builds and
deployments do not manage these caps, and neither the caps nor the separate
background configuration explains slow connect startup: measure connect
startup, origin admission and SQL execution separately. Telemetry concurrency
remains 1.

Each HTTP invocation lazily opens at most two strong and two cached database
sockets, so ordinary browser reads can overlap page enrichment. Its pools close
once the response body finishes (or the handler throws, without delaying the
error) and every `waitUntil` task it registered has settled (`withRequestDb`);
an upgraded socket keeps pg's idle timeout. Four database sockets leave two of
the Worker's six outbound connection slots for provider/DO/storage/telemetry
calls. One Worker serves all events.

#### Background connection budget

Every background invocation — one queue permit, one telemetry batch, the hourly
cron tick, or one Durable Object request — holds exactly one shared two-socket
pool on `HYPERDRIVE_BACKGROUND` (`withInvocationDb`); both database roles
resolve to it, and it closes when the invocation finishes. Code called inline
from an invocation that already holds a scope (a purchase dispatch delivering
to its coordinator's services, for example) reuses that pool instead of opening
a second one. The invariant is

`2 × (background max_concurrency + telemetry max_concurrency + cron + live Durable Object requests) ≤ 40` (the background origin cap)

The queue consumers' `max_concurrency` bounds permit and telemetry
invocations: 8 background (`packages/shared/src/background-queue-consumer.json`)
and 1 telemetry (`apps/web/cloudflare.config.ts`), so at most 18 sockets. The
cron runs its backstop and the daily pass one after the other, so 2 more. That
leaves 20 sockets for Durable Object requests.

Purchase coordinators (one `PurchaseImportRunAgent` per import Run) share a
household-wide cap of 6 concurrent work turns, about 12 sockets, leaving room
for CalendarFeed rebuilds and other Durable Object requests, which are bounded
only by their own traffic. The singleton `CoordinatorGateDurableObject`
(`purchase-import/operations/coordinator-gate.ts`) admits them without
Postgres, so a waiting coordinator opens no database scope.

- **Turns.** Before an alarm, a dispatch or a member prompt loads the agent,
  its host asks the gate for the Run's turn (10-minute lease) and keeps it
  while pi works, renewing on every entry, on a heartbeat and before database
  work near the lease's end; the check that confirms pi idle releases it. An
  idle check that fails or does not answer within 10 s is undecidable; three in
  a row spanning two heartbeats stop renewal: database work ends at the current
  deadline and the coordinator asks again after lease plus grace. One
  in-instance step queue orders acquire, renew, idle check and release.
- **Fence.** pi's Run services refuse database work once the turn is lost
  (`CoordinatorLeaseLostError`, transient), so the Run takes its existing
  transient path.
- **Queue.** Refused coordinators wait in one FIFO list and keep their place
  across polls. A freed slot is reserved 60 s for the first eligible waiter,
  which the gate wakes (`turnReady`); holders plus live reservations never
  exceed the cap, and a later waiter overtakes only while the head leaves its
  reservation unclaimed. Unpolled waiters leave after 15 minutes; a lapsed
  holder's slot is re-granted only after its lease plus a 5-minute grace.
- **Waiting.** Nothing loads: an alarm re-arms 15 s–5 min later besides the
  gate's wake; a `purchase.dispatch` defers with `provider_capacity` and no
  attempt while its coordinator keeps polling on the same alarm backoff, and
  brings the Job forward when reserved a turn (fallback
  re-poll 8–12 minutes, 1–2 minutes when the gate cannot be asked); a prompt
  takes only a turn free beyond every reservation and otherwise answers 503
  with `Retry-After` without joining the queue. A member's stop never waits.
- **Runs.** The cap starts, resumes, retries, cancels and reassigns nothing.
  Stale-Run expiry skips Runs holding or queued for a turn (the gate's
  `status()`), so a just-granted Run is exempt until its lease plus grace
  lapses, and expires nothing when the gate cannot answer.

Past the budget, Hyperdrive queues for an origin slot and then fails the query
with SQLSTATE 58000 "Timed out while waiting for an open slot in the pool".
Those failures are transient (no attempts spent; see [Jobs](jobs.md#retries)),
so exceeding the budget slows work rather than losing it.

Watch for the margin running out:

- `58000` pool-slot timeouts in Sentry, grouped by the `cubby.background.unit`
  tag, and coordinator admission faults on purchase Runs.
- `Job.lastExecution.errorClass = 'transient'` on Job and `background.drain`
  record rows (`drain:<unit>`), and a rising `queryMs` relative to `wallMs`.
- Long `db.acquire` spans on queue, cron and Durable Object traces.
- The background configuration's origin connection count in the Hyperdrive
  dashboard approaching 40.
- Coordinator turn waits: `cubby.coordinator.turn = waiting | unavailable`
  (with `.holders`, `.position`, `.retry_ms`) on `purchase-agent.alarm` and
  `.dispatch` spans and as a Sentry tag, the `purchase-agent.turn` log, and
  deferred `purchase.dispatch` Jobs (`Job.lastExecution.outcome = 'deferred'`).
  The gate's own state is its `status()` RPC on
  `env.COORDINATOR_GATE.getByName("household")`: the Run ids holding a turn and
  those queued, in order (the same read stale-Run expiry uses); its storage holds
  the full queue under the `gate` key.

Raise `max_concurrency` only with the origin cap, and only after measuring pool
waits.

Editing Neon's autoscaling bounds restarts the endpoint and disconnects active
sessions; automatic resizing within those bounds does not. Apply a range change
away from critical writes or migrations, then verify reconnects and read
latency. Reverting the range also restarts the endpoint. See
[Neon compute management](https://neon.com/docs/manage/computes) and
[Hyperdrive pool tuning](https://developers.cloudflare.com/hyperdrive/configuration/tune-connection-pool/).

Runtime database roles use Hyperdrive bindings to the same direct Neon origin:

| Binding                 | Purpose                                                              |
| ----------------------- | -------------------------------------------------------------------- |
| `HYPERDRIVE`            | Authoritative reads and writes; caching disabled.                    |
| `HYPERDRIVE_CACHED`     | Ordinary bounded-stale display reads.                                |
| `HYPERDRIVE_BACKGROUND` | `withInvocationDb` queue/cron/DO/coordinator work; caching disabled. |

Hyperdrive configurations and their origin/cache limits are operator-managed.
Builds and deployments do not create configurations, tune pools, restart them
or change credentials. The background binding must reference an existing
approved configuration before release. Local/test profiles substitute the
guarded checkout URL for all three bindings. The per-invocation code budget
reserves connection slots for non-database subrequests independently of
provider pool settings.

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

| Name                   | Storage                        | Purpose                                                                                                                                                                                            |
| ---------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | `cubby` Worker secret          | Better Auth signing/encryption                                                                                                                                                                     |
| `R2_ACCESS_KEY_ID`     | `cubby` Worker secret          | Main R2 S3 credential                                                                                                                                                                              |
| `R2_SECRET_ACCESS_KEY` | `cubby` Worker secret          | Main R2 S3 credential                                                                                                                                                                              |
| `GOOGLE_CLIENT_SECRET` | `cubby` Worker secret          | Google OAuth confidential credential                                                                                                                                                               |
| `GOOGLE_CLIENT_ID`     | Checked-in Worker `vars` value | Public Google OAuth client identifier                                                                                                                                                              |
| `APNS_KEY_ID`          | `cubby` Worker secret          | APNs token-auth key id (photo-run Live Activities and alerts)                                                                                                                                      |
| `APNS_TEAM_ID`         | `cubby` Worker secret          | Apple Developer team id that owns the APNs key                                                                                                                                                     |
| `APNS_PRIVATE_KEY`     | `cubby` Worker secret          | APNs `.p8` PKCS8 PEM; absent = pushes recorded unsent                                                                                                                                              |
| `AI_GATEWAY_API_KEY`   | Worker/local secret            | Cloudflare API token: authenticated REST inference, including named subscriber BYOK and paid third-party passthrough; with account-scoped Workers Observability Edit it also reads inline Job logs |

OAuth client IDs, Cloudflare account IDs, resource IDs, public origins, and
Sentry DSNs are identifiers, not credentials. They may be committed. OAuth
client secrets, R2 secret keys, auth secrets, API tokens, and provider keys must
not be committed.

Photo import alert topics follow the registering build's canonical app
identity, including the separate Mac development bundle. Live Activity
registrations use the production Cubby app identity. Enable Push Notifications
on each App ID and refresh its signing profiles before validating delivery;
configuring an APNs key alone does not add the signed-client entitlement.
Delivery results apply only while the token, app identity and APNs environment
still match the registration that sent them. Correcting any of these resets
delivery state and prevents a late response from ending the corrected
registration. Alert delivery keys also include the cumulative planned photo
count, so a late response from an earlier batch cannot end a later batch in the
same phase.

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

An External app may stay in Testing with household Google accounts listed as
test users, but Google expires Testing-mode grants after seven days, so
unattended hourly Gmail discovery requires publishing the app to Production. A
private personal-use app may remain unverified and display Google's warning; do
not expand its audience without revisiting Google's restricted-scope
verification and data-handling requirements.

Better Auth stores the resulting per-member access and refresh tokens encrypted
in its `account` table. Cubby requests read-only Gmail access and does not store
Google passwords.

Google sign-in on the web and Apple apps uses this same OAuth client and
requires the Gmail read-only grant. It only signs in existing Cubby users:
verified Google email can link to the matching existing household account, but
Google cannot create a new user. Password login remains available and public
signup remains closed. Reconnecting Google from Settings renews Gmail consent;
disconnecting Google removes both Google login and Gmail access.

The Apple apps use `ASWebAuthenticationSession` with `/auth/native`, backed by
the server and browser-proxy exports of `@better-auth/electron` (no Electron
runtime). The `cubby-native` client uses PKCE and the `cubby://auth/callback`
scheme. Its single-use code is exchanged at `/api/auth/electron/token`; native
clients persist the signed `set-auth-token` header, never the raw token in the
JSON response. Both password and Google login use the same Keychain/session
completion. This reuses the production Google callback above; it does not
require separate iOS or macOS OAuth clients. Local and preview environments
keep password login.

## AI providers

Credit BYOK, Jev BYOK, Workers AI, and live-evaluation use gateway `cubby`.
Paid OpenAI/Anthropic Unified Billing uses gateway `cubby-testing`
(`CUBBY_PAID_AI_GATEWAY_ID`): Cloudflare refuses wholesale on `cubby` while
named BYOK keys exist (`2049` / "Insufficient balance…") even with a positive
account credit balance, and `cubby-testing` has no provider keys so paid draws
the same credits. Keep provider keys off `cubby-testing`. Production uses the
Workers AI Gateway binding: `AI.run` with an explicit gateway for Workers AI
models, and `AI.gateway("cubby").run` for managed providers. Named
subscriber-credit BYOK uses native authenticated passthrough instead; see setup
below. Tools outside Workers use explicitly authenticated REST requests.
Workers AI REST calls use the account `/ai/run` endpoint with gateway routing,
metadata, caching and timeout controls in `cf-aig-*` headers (not body
options), avoiding a nested unscoped provider call. Every REST request names
the gateway explicitly: the first authenticated request without a gateway ID
recreates `default` even after it is deleted
([manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/#default-gateway)).
The `AI_GATEWAY_API_KEY` environment variable authenticates the direct REST
fallback used outside Cloudflare Workers; the deployed Worker also needs it for
third-party native passthrough, and only Workers AI runs on the binding alone.

Gateway metadata has three stable dimensions: `environment` (`production`,
`ci`, or `development`), `feature`, and `operation`, with optional `entityKind`.
The outbound transport filters to that contract. Model/provider, input counts,
entity and run identifiers, document paths, chunks, revisions and prompt
versions stay in application accounting or traces rather than gateway metadata.
Cloudflare saves only the first five metadata entries per request, and a spend
rule split by a high-cardinality key gives every value its own budget
([custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/),
[spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)).
Cookbook metadata used for model pricing is read before outbound filtering. The
live-evaluation gateway peer (`apps/web/tooling/ai/live-gateway.ts`) preserves
application feature/operation attribution, sets its own environment, and always
bypasses gateway caching because the documented cache key does not include the
gateway or metadata, so shared-gateway traffic can return another environment's
cached response
([caching](https://developers.cloudflare.com/ai-gateway/features/caching/#how-the-cache-key-works)).

Credit and Workers AI use `cubby`; paid Unified Billing uses `cubby-testing`.
`environment` metadata separates logs and spend rules across those gateways.
Both gateways share Cloudflare's Unified Billing allowance of 200 requests per
60 seconds. The egress DO admits a rolling 180
starts/minute and at most 64 in-flight requests in the `unified` bucket,
covering Workers AI and paid managed-provider calls. The 20-request margin
leaves room for clients outside the Worker. 64 is an operating safety bound,
over twice the concurrency needed at ten-second latency, not a published
provider concurrency limit.
[AI Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
exclude BYOK from that rate limit.
[Workers AI limits](https://developers.cloudflare.com/workers-ai/platform/limits/)
publish 300 RPM for ordinary text generation and 2,000 RPM for classification;
models requiring the Paid plan instead have per-model 20 RPM standard / 50 RPM
prepaid limits. Clef is not a Paid-plan-only model. These docs publish no fixed
Workers AI concurrency ceiling. Provider 429s and `Retry-After` remain
authoritative.

The `subscriber-credit:anthropic` BYOK bucket has independent permits and
cooldowns, with no invented universal concurrency cap: Anthropic's
[limits](https://platform.claude.com/docs/en/api/rate-limits) depend on the
organization, model, requests and tokens. The ChatGPT subscription transport
bypasses AI Gateway and publishes
[plan-dependent usage limits](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan),
not a fixed RPM/concurrency allowance; it has no local model fan-out cap and is
not charged to the unified bucket. A full unified bucket never consumes credit
capacity. Subscriber-credit 429s cool only their bucket; unified 429s keep a
shared cooldown because their provider limit scope is unknown. A spend limit can
filter by `environment`, but cannot separate the shared request allowance.

Gateways are not a security boundary: AI Gateway tokens are account-scoped, so
any `Run` token reaches every gateway and its stored BYOK keys
([authenticated gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)).
Dynamic routes accept only the OpenAI chat-completions shape, so Anthropic
Messages calls cannot use them
([dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/)).
Provider routing and model identifiers live in
`packages/shared/src/ai/models.ts`, which supplies model IDs, provider names,
capabilities, role-specific schemas and defaults for application and tooling
callers. Provider credentials and unified-billing configuration are Cloudflare
AI Gateway state; no provider key belongs in this repository. Verify that every
model in the checked-in registry is enabled in the gateway before relying on a
feature that selects it.

### Claude subscriber credits

**Funding ladder.** Every tier-routed chat call climbs the source-first ladder
that [ADR 0027](adr/0027-tier-routed-models-on-a-funding-first-ladder.md)
records and `fundedChatAttempts` implements: Claude subscriber credits, OpenAI
API credits, the ChatGPT subscription, then paid Unified Billing, each answering
with its route's model for the call's tier (`CHAT_TIER_MODELS`). A step advances
only on a funding refusal. Window budgets, the plan budget and their defaults
live in `apps/web/src/server/ai/budget.ts`; this page owns the provider setup
and the refusal mechanics below. Run funding pauses and resumption are in
[Durable Jobs](jobs.md#funding-waits).

Provider credits (Claude and OpenAI API) have no window budget: each runs until
its provider refuses, and the status reports its standard-cost spend by provider
under billing reason `subscriber_credit`. Background work (a Run whose lineage
root was scheduled, discovered or backfilled) draws the ChatGPT plan only
within its window budget (`planLimitUsd`, $2 when never set, at standard cost), because
the household shares the plan with its own use. Past it, `beforePlanRequest`
returns a `cubby_plan_budget_reached` funding refusal and the ladder moves on;
an unladdered plan call skips the plan for its paid or subscription-required
path. The plan preflight (`planRunPreflight`) recognizes a chat call by endpoint
path: pi-ai's Anthropic SDK posts `v1/messages?beta=true`. Paid calls stay
within the paid budget (`paidRunPreflight`); a member's `run_now_paid` control
event ("Run now, paid allowed" on the Run page, "Run discovery now, paid
allowed" on the Mail import card, or MCP `run.lifecycle`/`run.discover_mail`)
lets that Run and the imports its discovery starts pay past the paid budget by
the confirmed `paidOverBudgetUsd` for the granting window.

**Credit refusals are held, not retried.** When a credit response is a funding
refusal `classifyFundingRefusal` recognizes (a Console spend limit, a spent
balance), the `AI_GATEWAY_EGRESS` Durable Object records it with the raw body
until the date Anthropic names ("You will regain access on …"), else the end of
the current six-hour window. While it holds, credit admission answers at once
with a `cubby_credit_refused` 400 carrying that raw reason and makes no upstream
call, so every ladder moves on to OpenAI API credits; unified (paid) traffic is
unaffected. One credit request per window passes as a probe: success clears the
refusal, another refusal records it again. "Retry Claude credit now" (Settings →
AI funding, MCP `ai_funding.reset_funding_refusal` with `source: "credit"`)
clears it and resumes funding-paused Runs. `ai_funding_read.status` and the AI
funding card report it as `credit.state` `refused`, with `until` and `reason`.
A streamed response settles its hold when the stream ends, not when its 2xx
headers arrive: a stream that ends in a terminal funding refusal (an SSE
`error` or `response.failed` frame) records it, a clean end clears it, and an
aborted or broken stream leaves the hold as it was.

**The paid gateway balance is held the same way.** When a paid Unified Billing
response (400, 402 or 403; Workers AI bills separately and is never gated)
carries an empty-balance refusal (`classifyFundingRefusal` kind
`gateway_balance_empty`; a missing BYOK
credential is one provider's setup failure and is never recorded), the egress
object records it as `paid:gateway` with the raw body until the window end.
While it holds, paid admission answers at once with a 402 replaying that raw
body, so every paid caller pauses for funding exactly as on the gateway's own
refusal, without an upstream call; a paid success clears it. "Retry paid now"
(MCP `ai_funding.reset_funding_refusal` with `source: "paid"`) and a member's
paid grant clear it; a budget change does not. It reads as `paid.state`
`refused`.

Each source in `ai_funding_read.status` carries a server-derived `availability`
(`usable`, `blocker`, `until`) for background work: a recorded refusal or plan
connection problem outranks a spent window budget. Settings shows it as one
Status chip per row (green usable, amber recovers by itself, red needs a
member), with the raw reason behind that row's Details and its recovery action
on the same row. A funding pause names its source: a paid refusal pauses the
Run with `Paid models unavailable: <why> (<raw>); retrying at <window end>`,
where `<why>` is an empty AI Gateway balance, a missing BYOK credential, or an
exhausted provider credit balance, while a spent paid budget keeps
`AI budget reached: $X of $Y paid…`.

Setup:

1. Link the eligible Claude plan to the intended Anthropic Console organization.
2. Create a dedicated Cubby workspace with a monthly spend limit no larger than
   the included allowance, then create an API key in that workspace. Keys draw
   from the organization's shared credit balance; purchased credits and
   auto-reload can otherwise keep the key usable after promotional exhaustion.
3. In Cloudflare **AI → AI Gateway → cubby → Provider Keys**, add the Anthropic
   key with alias **subscriber-credit**. Never put it in repository files, CI,
   application environment variables or chat. Leave the **default** Anthropic
   BYOK key unset on `cubby`. Do not store provider keys on `cubby-testing`.
4. Keep Unified Billing enabled and Require provider credentials disabled on
   `cubby-testing` for the paid route. Credit requests explicitly send the
   named alias and `cf-aig-no-wholesale: true`; a missing or invalid key fails
   with raw setup diagnostics rather than silently spending paid credits.

Production paid OpenAI/Anthropic chat uses Cloudflare's dedicated
[`/ai/v1/responses`, `/ai/v1/messages`, or `/ai/v1/chat/completions` REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
scoped to `cubby-testing`. It preserves each provider's wire format and changes
only `model` to the explicit Cloudflare catalog id declared in `models.ts`
(including dotted Anthropic ids). The dedicated endpoints
[consult only default BYOK keys before Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/),
whereas Universal `gateway.run()` and native unaliased paid requests fail BYOK
alias resolution when non-default keys exist; keep default keys unset and keep
named keys off the paid gateway.

Credit uses native provider passthrough with both `cf-aig-byok-alias:
subscriber-credit` and `cf-aig-no-wholesale: true`. Explicit alias or
no-wholesale intent is never removed to select paid routing. Other provider
protocols keep native routing. Every runtime sends every
gateway request through the `AI_GATEWAY_EGRESS` Durable Object, which
preserves controls, metadata, query suffixes and streaming; there is no
binding-free path. Dedicated REST authenticates with `Authorization:
Bearer` and scopes requests with `cf-aig-gateway-id`; native passthrough uses
`cf-aig-authorization`. Both use the `AI_GATEWAY_API_KEY` Worker secret (a
Cloudflare inference token with Workers AI Read, not a provider key). Jev BYOK
uses that secret on `/ai/run` with no-wholesale through its own BYOK-only route.
Deploys do not provision or overwrite secrets or grants, and missing
authentication fails explicitly. Workers AI keeps its binding, and the live
purchase-agent harness keeps its Universal shim.

Console spend limits reset on the first of the calendar month, while
promotional credits refresh on the subscription billing cycle. A workspace cap
is therefore not an exact promotional-balance detector: an organization with
purchased credits may spend those before its cap. Console Billing owns the
actual balance and expiry; do not infer them from Cubby's usage totals.
Requests that omit gateway scoping can recreate Cloudflare's `default` gateway.

### OpenAI subscriber API credits

Link the OpenAI subscription credit benefit to the intended API organization,
then create a dedicated Cubby project key in that organization. Store it in
**AI → AI Gateway → cubby → Provider Keys → OpenAI**, alias
**subscriber-credit**. Keep the default OpenAI key unset and keep Unified
Billing for the explicit paid rung. No OpenAI key belongs in Worker secrets or
source.

OpenAI credit calls use native Gateway passthrough with the named alias and
`cf-aig-no-wholesale: true`, bypassing ChatGPT OAuth and paid admission. Only
`credit_balance_exhausted`, `insufficient_quota`, an OpenAI Cubby credit
admission refusal, or OpenAI's "no credits remaining" sentence in the provider
error message when the envelope has no code, advance to the ChatGPT plan;
invalid keys, rate limits and unknown failures remain errors. An OpenAI credit
refusal that is still the turn's terminal error pauses the Run and names the
exhausted provider credit balance. A Claude credit refusal does not park an
Anthropic-pinned Run. Credit refusals and cooldowns are isolated by provider.
OpenAI refusals without a reset date last until the six-hour window ends;
resetting API credit refusals clears both providers and permits fresh attempts.

Semantic embeddings use the same named OpenAI-credit transport through shared
egress, and on a credit refusal retry once as paid Unified Billing: `/ai/run`
on `cubby-testing` with the model's catalog id (`openai/text-embedding-3-small`),
whose answer arrives wrapped in `result`. They keep their fixed embedding model,
never try the ChatGPT plan, and have no window budget. When paid refuses too, a
member's search fails with a readable error and background refresh waits for
funding with its work owed. Response caching and usage accounting apply;
credit usage records the subscriber-credit zero-charge evidence, paid usage
its standard cost, and cache hits keep their cache reason.

OpenAI applies free credits before purchased credits, and unused subscription
credits expire each billing cycle. An API key does not distinguish promotional
from purchased balances: an organization with purchased credits may keep
billing after the promotional balance is exhausted. Cubby window budgets are
soft usage pacing, not a live promotional-balance meter. See
[OpenAI API credit rules](https://developers.openai.com/api/docs/guides/chatgpt-api-credits).

### Pricing and transport

AI catalog/pricing is owned by `packages/shared/src/ai/pricing.ts`; runtime
model defaults by `packages/shared/src/ai/models.ts` and feature tiers by
`apps/web/src/server/ai/policy/features.ts`. Retier only with live-eval
evidence or an explicit member choice; small ceiling-scoring evals cannot
establish parity. Pricing belongs to accounting, outside inference.
Unavailable prices stay unknown; failed calls without reported usage are
unpriced, and token evidence is not a second SDK cost estimate.

The shared transport owns request controls, response headers, Universal
gateway calls, and the choice between test peers, ChatGPT and billed gateway
calls. ChatGPT selection fails closed if that transport fails. Chat, decision,
embedding, cookbook and native recovery calls keep their protocol-specific
payloads and retry policies. Gateway cache verdicts describe upstream billing;
application `cacheStatus` describes the caller's own cache.

### Decision runner

Decision assignment, caching, request bounds and response envelopes belong to
the shared decision runner (`server/ai/decision-model.ts`).

- Independent all-or-fail decisions use `runDecisionChoices`; callers keeping
  partial answers settle choices with outcomes that carry their original typed
  work item, and the cooperative option owns the Job's yield scope. Both wait
  for every started request before returning, including when a sibling fails.
  Callers do not maintain parallel question-index arrays.
- Finite collections that must prepare evidence or perform dependent choices
  use `settleDecisionWorkItems`. It bounds preparation, releases preparation
  slots while questions wait, and submits compatible cache misses in waves. Each
  question keeps its originating input-capture context; each work item keeps
  its own usage attribution and outcome. Use a shared usage object only when
  the collection has one attribution owner.
- Cache hits keep their individual keys, while owned cache misses share
  requests only within the same feature, selected model, usage context and
  embedded image content. Shared images are sent once per batch; different
  media and text-only questions stay in separate requests. Batches carry at
  most 64 independently scoped questions and stay within the runner's
  serialized text budget; larger sets split without dropping candidates.
  Waiting on another request's cache lease does not hold up owned misses. Each
  upstream batch records usage once and still passes through gateway egress
  admission. Dependent decision phases wait for their required answers before
  starting another batch.
- Request serialization runs synchronously before entering the async
  transport, so the suspended frame keeps only the body and expected question
  keys. The serialized body is identical across throttled retries; response
  keys must match the complete expected set.

Mail attachments prepare their email evidence once; image provenance freezes
its roster and rejects failed decisions before publication. USDA and
ingredient-merge batches keep per-ingredient errors; UPC offer judgments share
one request context inside each lookup, while the outer UPC loop keeps quota and
rate-limit stopping behavior. Paired field audits record
`Suggestion.data.served` explicitly; list filters use that flag, ordinary field
answers are served by default, and paired publications without a boolean flag
fail. Immutable model attribution remains intact. Product identity grounding
batches source-literal questions before eligible relation questions; usage is
attributed to the literal or relation phase, while individual dimension
prompts, source literals and fingerprints stay in receipts.

Field decision prompts are measured from a Claude/Codex session over Cubby MCP,
following `.agents/skills/decision-grading`: reviewed Suggestions
(`suggestions_read.list` with `status`) are the labels, and
`ai_read.suggest_fields` with `decisionModel` replays a record through Jev or
Clef server-side. Only aggregates leave the session.

### Image analysis

Image composition and identity-scope questions share a batch before dependent
category and catalog work. Image decisions route to vision-capable Clef
independently of the text-only Jev trial. Photo identification prepares
renditions before the shared adapter checks embedded media and uses the
gateway, retry, cache and usage paths. Media limits and payloads belong to
`server/ai/decision-model.ts` and
`server/domains/image/service/image-identification.service.ts`.

Image description consumers select confirmed corrections first, then the
current preferred cloud result, then the newest available source-matching
observation. A newer Apple observation does not displace a preferred cloud
description; observations for replaced image content are historical evidence
only. Both direct and batch confirmation readers require the live Image hash to
match the immutable Suggestion subject/fingerprint and its current projection.
Replaced or deleted content hides the old confirmation from current
descriptions while keeping its confirmed value, original prediction and
application receipts. Current-content display does not itself grant
cross-image propagation authority: propagated text also requires its automatic
effect receipt and typed root ownership to match the selected holder. Direct
status and batch evidence keep that ownership; web photo evidence and native
Image detail distinguish it from a direct member confirmation and expose the
source application receipt behind evidence disclosure. Native status reload
clears prior current descriptions before fetching, so a failed refresh cannot
keep an unverified confirmation. The composable classification reader shares
the content/effect proof and excludes model observations that cannot prove the
current image hash. Model job results, claims and cutout outputs remain
independent retained observations.

Identification keeps visual composition separate from identity scope. Multiple
related views, parts or life stages may support one catalog identity;
unrelated objects, documents and uncertain scenes abstain from single-identity
matching. Suggestions remain unconfirmed and never change inventory or identity
automatically. Prompt/schema revisions fence reuse; historical observations
are kept rather than rewritten. Clef classifies composition, selects a
category, shortlists bounded catalog candidates, then compares the source
rendition with at most three independently attached Product references. A
source image never matches itself by id or content hash, and a borrowed gallery
image is not independent evidence. Candidate names are hints; a search over a
truncated roster reports the truncation and is never presented as exhaustive,
and option probabilities are not calibrated confidence. Matching the same
Product does not establish that two photos show the same possession. Member
corrections take precedence; later machine evidence may flag a confirmed match
for review but cannot replace it. Reads never start inference, and retained
results for deleted targets or changed source content are filtered out. AVIF
sources wait, without consuming attempts, for the normalization job's verified
JPEG snapshot.

Execution (device parking, leases, retries, cutouts) is owned by
[Durable Jobs](jobs.md#image-processing). Payload bounds: JPEG analysis reads
are bounded before buffering, description and companion normalization at
4 MiB, identification at 2 MiB. Four overlapping descriptions hold at most
16 MiB of retained rendition bytes, with additional bounded streaming,
inspection and upload copies; this is a payload bound, not a measurement of
total isolate memory. Originals remain unchanged when an oversized rendition
fails with its raw size diagnostic. Provider admission separately bounds paid
model starts, and none of these limits reserves interactive Hyperdrive
connections. Identification requests a server-only edge JPEG bounded to 1024
on both axes, because UI width rungs bound only the width and a tall portrait
can exceed the 2 MiB budget. The source and every candidate reference share
this rendition. When the edge answers 422 because it cannot decode a PNG (its
decoder rejects a damaged ancillary chunk around intact pixels), the Worker
reads the original, at most 16 MiB, and the Rust `prepare_analysis_png` streams
its rows into the same bounded JPEG. Other refused formats keep the raw edge
diagnostic.

## Observability

### Inline Job logs and limits

Job claim/page/publish/defer/fail logs emit one JSON object with `runId`,
`jobId`, `kind`, `jobKey`, `stepKey`, `generation`, `attempt` and `waitReason`.
Workers Logs indexes
[structured JSON objects](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#logging-structured-json-objects);
raw errors keep their credential-scrubbed diagnostic detail.

A Run's Diagnostics section and an Image's or Location's Jobs slot read one
Job's raw Worker lines through `job.logs`
(`server/generic/jobs/service/job-logs.ts`). It calls the Workers Observability
telemetry query API,
`POST /accounts/{account}/workers/observability/telemetry/query`.

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
- **Retention.** A window older than Workers Logs' 7-day retention reads "raw
  logs expired".
- **Failures.** A failed query shows its raw response, redacted only by
  `scrubErrorMessage`, with Retry and the dashboard link.

Run plan, ETA and page-sample contracts are in
[Durable Jobs](jobs.md#run-progress-and-diagnostics).

### Error tracking and traces

The web/Workers Sentry DSN is intentionally public and defined exactly once, in
`packages/worker-tracing/src/sentry-dsn.ts`; the web client and Worker, the
dev-only Node preload, and every auxiliary Worker import it from there. The
native app uses a separate `cubby-apple` Sentry project. Authentication and
ownership for both projects remain provider-side state. Hermetic Worker tests
set `SENTRY_ENVIRONMENT=test`, which disables error delivery through the same
policy as the E2E runtime. A missing test identity otherwise defaults the
Durable Object wrapper to production with an unknown release, so those tags
alone do not establish production origin.

Cloudflare joins service-binding, JS RPC and Durable Object subrequests into one
trace, so the Run page's proxy into the purchase agent's Durable Object appears
in the request's trace in the Cloudflare dashboard. A queue delivery starts a
new trace in the consumer; `run.id` on the consumer's job span is the join key
back to the producer's job spans. Trace context never propagates to services
outside Cloudflare.

`withInvocationTrace` loads the native tracing runtime before looking up the
active invocation span, then annotates that span and creates a timing child.
Fetch handlers, queue batches, scheduled maintenance, Durable Object alarms,
purchase-agent dispatch RPCs and search-index repair Jobs use this entry
helper, so a fresh isolate needs no preceding fetch. Batch spans carry queue
name and size; individual messages keep their own run context instead of
assigning one actor or run to an entire batch. Cron spans include the trigger
and scheduled time, including maintenance-mode skips. Alarm and Job spans
identify their workload; purchase-agent alarm/RPC spans also identify the Run.
Entry annotation never ends the platform-owned span. Other code uses
`withTrace` for child operations and `annotateActiveSpan` for an already
initialized active span. Outside the Worker build these helpers run work
without tracing.

Database query spans carry `cubby.db.caller`: the nearest enclosing Start
query/mutation, Job, workflow/routine step, or HTTP route span name. The tracing
wrappers propagate the name stack through AsyncLocalStorage, including queued
client work and concurrent siblings; intervening database, list and provider
spans do not replace the semantic owner. Jobs use the execution context's kind
and selected step (`job.<kind>.<step>`) in preference to the span stack,
including when no native span is recording. Other traced work falls back to its
nearest non-database span; untraced work omits the attribute. This supplements
`db.query.text`, `db.query.parameter_count`, binding role and returned-row count for caller-level query
comparisons without exporting record identifiers or arguments.

Serialization failures also emit `db-transaction` structured logs
independently of trace sampling. Each aborted attempt records `requestId` when
the Start request supplied a valid Ray ID, `boundaryId`, `rootBoundaryId`,
`rootAttempt`, `parentBoundaryId`, `callerOwned`, `caller`, `isolationLevel`,
`attempt`, `limit`, `startedAt`, `durationMs`, `boundaryDurationMs`, `phase`,
`beforeCommitKey`, `sqlState`, `retry` and `retryDelayMs`. Recovery records the
committed attempt before after-commit consumers run; those consumers cannot
enter the retry catch. Unknown raw caller-owned boundaries omit ancestor
identity instead of inventing an outer attempt. These logs carry no SQL
parameters or submitted evidence. Job publish/fail logs also keep
`publicationStartedAt` and `publicationDurationMs` when a publication was
attempted; compare those intervals and the exact refresh key with the aborted
transaction interval to find candidate competing publications. Overlap alone
cannot prove which writer replaced the tuple, and Job publication intervals
exclude business writes during handler preparation and source invalidation from
other callers. Current Job idleness does not establish whether a page published
during the failed request. Pool slot timeout `58000` is a separate diagnostic
from serialization `40001`.

Authenticated Start, workflow-stream, HTTP and MCP failures follow the
[raw diagnostic contract](agents/domain-rules.md#error-diagnostics). Only
credential-shaped values are redacted. Request-scoped reporting captures the
original exception and supplies correlation/Sentry references; a capture ID is
an attempt, not proof of ingestion, and MCP batch items keep separate
references. Operation dispatch authenticates before reading input. A session
lookup failure keeps the context stage and a generic unauthenticated message;
only input parsing and validation failures use the input stage. Authentication
failures must not be presented as invalid operation input.

Authenticated diagnostics keep complete messages, stacks, SQL and parameters,
upstream response bodies, and all distinct causes, with cycle detection rather
than arbitrary character or cause-count limits. Error classification can still
bound its search; classification limits must not truncate the displayed
evidence. Credential scrubbing also decodes JSON property names and embedded
JSON strings, including escaped quotes, before preserving their diagnostic
content. The browser distinguishes an HTTP failure from an application error:
HTTP diagnostics keep status, URL, content type, body (including an explicitly
empty body), elapsed time, and available request/Ray/Sentry references. An empty
platform response cannot supply the underlying Worker exception; do not invent
one or replace it with an application `INTERNAL_SERVER_ERROR`. Response bodies
and stacks render as inert text, and Copy details carries the same complete
evidence. Terminal query failures keep earlier retry/fallback evidence.

Web error details include Copy details, the Sentry link, and Open Workers
Observability with a copyable Ray ID when Cloudflare supplied one. The
Cloudflare link opens the dashboard, not an individual trace: the custom-span
API does not expose the active trace ID. These references also survive native
API decoding.

Source maps for `apps/web` are generated and uploaded at deploy by
`sentryTanstackStart` (`vite.config.ts`), under release `cubby@<short sha>` —
the same value the browser (`router.tsx`) and Worker (`worker-sentry.ts`) SDKs
report via `Sentry.init`/`withSentry`. No commit reaches the bundle: the plugin
does not inject the release (`release.inject: false`), and the runtimes read
`CUBBY_SOURCE_COMMIT`, `CUBBY_SOURCE_BRANCH` and `CUBBY_SOURCE_DATE` through
`getSourceRelease` (`apps/web/src/server/cf-env.ts`). Deploy uploads those as
the Worker version's secrets (`cf deploy --secrets-file`); the root document
passes the release to browser Sentry in a `cubby-release` meta tag. Identical
sources therefore build identical output at any commit, and unchanged client
assets are not re-uploaded. Unset values read as `unknown`. Client `.map` files
are deleted from the Build Output assets directory afterward so none are served
as Worker static assets. Server maps remain in the Build Output Worker bundle
for diagnostics. The build removes sourcemap entries from the native Build
Output manifest so `cf deploy --prebuilt` does not upload them again; the
combined map exceeds Cloudflare's upload limit. Map sources are rewritten to
repo-relative paths (`apps/web/src/...`, `packages/*/src/...`) so a single
Sentry GitHub code mapping (repo root -> repo root on `main`) resolves stack
frames from both the client bundle and the Worker bundle. The upload needs a
`SENTRY_AUTH_TOKEN` secret, present only in the `deploy.yaml` workflow;
PR/preview builds have no token, so the plugin injects debug IDs and deletes
client maps but skips the network upload. `SENTRY_IGNORED_ERRORS`
(`apps/web/src/lib/sentry-noise.ts`) lists known-noise messages dropped via
`ignoreErrors` before Sentry ingests them, so they never consume the free-plan
error quota.

The production Cloudflare configuration owns Workers Observability trace
persistence and sampling. Cloudflare is the only trace destination; no Jaeger,
Grafana Tempo or Sentry trace exporter is configured. Sentry continues to
capture errors on web, Apple and auxiliary Workers. The web build excludes
Sentry tracing and SDK debug statements through the upstream bundler options;
error capture, raw application diagnostics and source maps remain enabled.

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
resource types the deployment workflow manages. Production deploys always build
before invoking `cf deploy --prebuilt --mode production`. The deploy command
tags versions with the full commit SHA and supplies the commit subject plus
Actions run URL as the message. The token remains the Cloudflare authenticated
actor; version metadata identifies the code and deployment run.

GitHub Actions is the sole production build/deployment owner. The main Worker's
Cloudflare Git build connection is disconnected: disabling production builds
alone leaves the independent preview-branch build trigger enabled. Do not
reconnect it just for attribution. WASM is restored or built through the Nx
target in Actions, which installs `wasm-pack`; there are no Cloudflare-hosted
WASM builds or preview infrastructure. Production is the only deployed
environment.

## Apple platform

The native targets use Xcode-managed signing and the associated domain
`cubby.nickysemenza.com`. The web Worker serves the Apple App Site Association
file. Purchase-import browser control additionally requires the checked-in
Apple Events entitlement and usage description; macOS grants Automation and
optional Screen Recording permission per local installation. Hosted release
setup follows [the Apple release guide](../apps/apple/README.md#testflight-releases).

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
