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
| USDA food data                | Cloudflare Workers                 | Worker `usda-api`, D1 `usda-api-index`, R2 `usda-api-bundles`                            |
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
- [`apps/usda-api/wrangler.jsonc`](../apps/usda-api/wrangler.jsonc)
- [`.github/workflows/deploy.yaml`](../.github/workflows/deploy.yaml)

## Cloudflare

Account ID: `9f10f078d35d86c78dedece2300a6b88`.

### Main Worker

`apps/web/wrangler.jsonc` declares the reproducible part of Worker `cubby`:

- Custom domain `cubby.nickysemenza.com`; `workers.dev` production routing is
  disabled and preview URLs are enabled.
- Smart Placement and static assets.
- Service binding `USDA_API` -> `usda-api`.
- SQLite Durable Objects `DatabaseFreshnessDurableObject`,
  `CalendarFeedDurableObject`, `PurchaseImportDurableObject`,
  `ImageProcessingDurableObject`, `AiResponseCacheDurableObject`, and the
  purchase agent's `PurchaseImportRunAgent` (below).
- Workflow `cubby-search-index-repair`.
- Queues `cubby-background`, `cubby-telemetry`, and `cubby-purchase-agent`,
  each produced and consumed by this Worker, with settings in the Wrangler
  file.
- One daily cron trigger at 12:00 UTC; authenticated app openings enqueue
  catch-up work with a household-wide one-hour cooldown.
- Workers AI binding `AI` and AI Gateway `cubby`.
- Vectorize binding `VECTORIZE` ->
  `cubby-openai-text-embedding-3-small-1536`, dimensions `1536`, cosine metric,
  with string metadata index `entityType` (the property name predates the
  `entityKind` rename and stays: the index is provider-side state).
- Version metadata and the two Hyperdrive bindings below.

One-time creation commands that cannot be inferred or safely rerun by deploy:

```bash
pnpm --dir apps/web exec wrangler queues create cubby-background
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
- the `cubby-purchase-agent` queue consumer (`server/purchase-agent/queue.ts`),
  which fences duplicate and late `start_or_resume` deliveries with the Run's
  dispatch generation (`canDispatchCoordinator` / `acknowledgeCoordinator`),
  retries a transient failure, and fails the Run after three attempts;
- every model call through AI Gateway `cubby` on the Worker's `AI` binding,
  by the shared pi-ai providers (`@cubby/shared/pi-gateway`). The gateway
  shim disables parallel tool calls: pi ends a run on a terminating tool only
  when it is the round's sole call, so a pending browser command can never
  share a round with a non-terminating call.

**The trust boundary.** The agent reads untrusted vendor pages, mail, and
photos, so prompt injection must not reach anything beyond the run it serves.
It was a separate Worker with no database credential for that reason; it now
runs in this Worker behind an in-process boundary enforced by construction:

- The agent's code (`apps/web/src/server/purchase-agent/`) receives no `env`.
  Its host (`server/purchase-import/agent-host.ts`) builds a narrowed
  environment (`server/purchase-agent/environment.ts`): the AI Gateway, the
  scripted test model in the workerd harness, the purpose's MCP tool
  definitions, and the services of the one Run the object's name identifies
  (`importRunIdFromAgentIdentity`), so a coordinator cannot address another
  Run. The queue consumer gets a separate environment that resolves any Run's
  services and coordinator. The Agents SDK base class gets an empty
  environment.
- Every Cubby effect is a Run service (`server/purchase-import/agent-services.ts`):
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
`server/purchase-agent/run-agent.ts` on its first event, and the queue handler
loads the consumer when a `cubby-purchase-agent` batch arrives
(`apps/web/scripts/check-server-closure.ts` budgets both paths).

The agent supplies Cubby's typed tools (`server/purchase-agent/tools.ts`,
replay-safe, each effect memoized per operation id; their parameters are the
host contracts narrowed in `purchaseAgentToolInputs`), mounts the purpose's
Cubby MCP tools as `mcp__cubby__<tool>` from the same compiled catalog
the MCP server lists to it (`server/mcp/agent-tool-catalog.ts`, so the first
dispatch lists nothing), and adds the purpose's skill plus product enrichment
from `.claude/skills/`. Queue events and the finish nudge reach the model as
`<signal type="…">` user text (`signals.ts`); the nudge
(`<signal type="run_not_finished">`) is sent once per stretch of new tool
rounds when the model stops without a terminal tool. A Lifecycle job per
submission reports its settlement: `done` goes to `reconcileSettledRun`, an
unanswered submission to `markRunFailed` (`agent_failed` / `agent_aborted`).
The run page reads the conversation through `agent-proxy.ts` as the
`AgentConversation` contract (`packages/schemas/src/agent-conversation.ts`),
which the agent projects from pi's entries and live generation.

Native Workers Traces carry the consumer's `job.purchase_agent_event` span
(`run.id`, `event.type`, `dispatch.outcome`). Sentry receives the agent's
errors through the Worker's own configuration (`server/worker-sentry.ts`;
the Durable Object's issues carry tag `service: purchase-agent`); it receives
no traces, and model and tool content is never recorded in either
destination. Each model response's usage reaches `AiUsage` through
`recordAgentUsage`, with the transport selected before the request
([usage attribution](runbooks/chatgpt-plan.md#usage-attribution)).

Account syncs and explicit Purchase validation/Product enrichment runs share
the same queue. Each admitted run records a stable start-event id and the
consumer fences duplicates and late deliveries before agent admission. A
VendorAccount never has more than one active run: targeted launches reject a
busy account and link to its `PIR-*` page instead of creating an application
waiting queue. Run-scoped evidence is stored beneath the import-run R2 prefix
and remains separate from shared Image and Purchase document records.

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
SELECT c.client_id, c.public, c.require_pkce, count(r.id) AS active_grants
FROM oauth_client c
LEFT JOIN oauth_refresh_token r
  ON r.client_id = c.client_id AND r.revoked IS NULL
WHERE c.client_id = 'cubby-purchase-agent'
GROUP BY c.client_id, c.public, c.require_pkce;
```

Three suites exercise the real agent in the workerd harness's
`purchase-agent` profile (`apps/web/tooling/workerd-harness.ts`, the built
`cubby` Worker with a scripted model and gateway, driven through
`apps/web/tooling/purchase-agent-workerd-harness.ts`).
`apps/web/src/server/purchase-import/purchase-agent-scenarios.integration.test.ts`
(PostgreSQL tier) scripts only the coordinator model and the web Worker's
extractor/audit model, and asserts the database graph, run status, findings,
approvals, and replay fences of whole purchase journeys; it proves
orchestration, not model judgment.
`apps/web/tests/e2e/purchase-import-run.spec.ts` drives the same harness
through the browser: a vendor page's saved order mail is imported (one
confirmation, a stale-evidence refusal, and a selected batch), the live Run
page streams the conversation while a script `gate` holds the model
mid-run, and the committed Purchase is read back from the page and the
database. A script reads the run id from the coordinator's instructions
(`currentRunId`), as a real model does, because the browser creates the run. The opt-in, billed decision eval runs live
candidate models on 32 synthetic Product-identity, line-role, reversal,
settlement, and incomplete-evidence cases and scores each outcome correct,
unsafe, or reviewable miss, with latency and token cost. The web Worker is the
harness's primary Worker, so the evals queue the agent through the
`cubby-queue-producer` Worker, never through `listen()`'s URL:

```bash
pnpm --dir apps/web eval:purchase-decisions
# AGENT_EVAL_CANDIDATES=gpt-6-sol:high PURCHASE_EVAL_CASES=identity-exact-variant-sku
```

Neither uses an authenticated household session or production data.

The `purchase-agent` and `coupled` profiles (`startWorkerdHarness`,
`apps/web/tooling/workerd-harness.ts`) first take the machine-wide harness
lock, then check every Worker build they load (`COUPLED_WORKER_BUILDS` in `apps/web/tooling/worker-builds.ts`; today
only the web Worker, which hosts the agent) against the content hash in
`dist/web-build-provenance.json`. Locally a stale build is rebuilt in place
before workerd starts; in CI, where the Worker artifact must be current, a
stale build fails with the exact rebuild command. A suite holds the harness
across its tests with `holdWorkerdHarness()` in `beforeAll`, so the wait and
any rebuild never count against a test timeout.

Rollback: pause the `cubby-purchase-agent` consumer and deploy the previous
web and Apple versions. Postgres import rows and the retained
`PurchaseImportDurableObject` namespace remain compatible; a rollback past the
2026-10 merge of the agent into `cubby` also needs the separate
`purchase-agent` Worker and its consumer back.

### PostgreSQL and Hyperdrive

Neon owns the PostgreSQL database. Production compute is autoscaling
0.25–1 CU (it was a fixed 0.25 CU compute until the 2026-09-21 OOM incident).
The Hyperdrive origin connection caps below (12 + 5) and the background
queue's `max_concurrency: 10` remain sized for the 0.25 CU floor, not the
ceiling — revisit them together if the floor ever moves.

Cloudflare has two Hyperdrive configurations pointing at the same direct Neon
connection string:

| Binding             | Hyperdrive ID                      | Contract                                                                                             |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `HYPERDRIVE`        | `adc9757dfffd45bc94d5c2a66b2ad410` | Authoritative reads and writes; caching disabled; origin connection limit 12                         |
| `HYPERDRIVE_CACHED` | `427dd7a2876c4dccbe056d37fa7374ff` | Cache-eligible reads; 60-second max age, 15-second stale-while-revalidate; origin connection limit 5 |

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

The `usda-api` auxiliary Worker uses a native R2 binding: `USDA_BUNDLES`, bucket
`usda-api-bundles`.

Cloudflare DNS and the R2 custom-domain configuration must route
`media.nickysemenza.com` to the main bucket. Image delivery depends on
Cloudflare Image Resizing at that origin.

### D1 and auxiliary Workers

| Worker     | D1 database      | Database ID                            | Other state           |
| ---------- | ---------------- | -------------------------------------- | --------------------- |
| `usda-api` | `usda-api-index` | `e2e0037c-6046-4b66-85d9-03ceb0770db6` | R2 `usda-api-bundles` |

The retired `upc-lookup` Worker (D1 `upc-lookup-db`, R2 `upc-images`) is
replaced by the main Worker's `UpcLookupCache`; see
[the D1 migration runbook](runbooks/upc-d1-migration.md).

D1 migrations live beside each Worker and are an explicit operator step; the
package deploy scripts do not apply them:

```bash
pnpm --filter @cubby/usda-api run edge:d1:migrate:remote
```

Apply a migration before deploying code that requires it. The main
Worker uses service bindings in production and checked-in public URLs as
development fallbacks.

### Secrets and plaintext variables

Set deployed Worker secrets interactively so their values do not enter shell
history:

```bash
pnpm --dir apps/web exec wrangler secret put NAME --config wrangler.jsonc
pnpm --dir apps/web exec wrangler secret list --config wrangler.jsonc
```

| Name                   | Storage                        | Purpose                                                 |
| ---------------------- | ------------------------------ | ------------------------------------------------------- |
| `BETTER_AUTH_SECRET`   | `cubby` Worker secret          | Better Auth signing/encryption                          |
| `R2_ACCESS_KEY_ID`     | `cubby` Worker secret          | Main R2 S3 credential                                   |
| `R2_SECRET_ACCESS_KEY` | `cubby` Worker secret          | Main R2 S3 credential                                   |
| `GOOGLE_CLIENT_SECRET` | `cubby` Worker secret          | Google OAuth confidential credential                    |
| `GOOGLE_CLIENT_ID`     | Checked-in Worker `vars` value | Public Google OAuth client identifier                   |
| `AI_GATEWAY_API_KEY`   | Local secret only              | REST fallback outside the production Workers AI binding |
| `NOTION_API_KEY`       | Optional Worker/local secret   | Optional Notion integration                             |

OAuth client IDs, Cloudflare account IDs, resource IDs, public origins, and
Sentry DSNs are identifiers, not credentials. They may be committed. OAuth
client secrets, R2 secret keys, auth secrets, API tokens, and provider keys must
not be committed.

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

Production calls use the Workers AI Gateway binding and gateway `cubby`.
Provider routing and model identifiers live in
`apps/web/src/server/ai/models.ts`. Provider credentials or unified-billing
configuration are Cloudflare AI Gateway state; no provider key belongs in this
repository. Verify that every model in the checked-in registry is enabled in
the gateway before relying on a feature that selects it.

Closed-set decision calls run a random 50/50 trial between `typesafe/jev` and
`@cf/cloudflare/clef` (the full model). The shared runner samples once before
the application-cache lookup and keeps that model through retries. Each model
has its own cache key, so repeated identical inputs can return either model's
cached answer. Cache hits do not place an upstream request; 50/50 is the
request-assignment probability, not a guaranteed split of billed calls.
The selected answer drives the normal decision, including the existing 0.85
high-confidence/autofill threshold. There are no shadow calls or paired
comparison records. Existing AI usage records retain the selected model,
provider, latency, token counts and failures, including model-specific cache
hits. Compare upstream latency on rows with `attempt > 0`, excluding
application-cache hits. `CLEF_TRAFFIC_SHARE` in `models.ts` controls the trial:
0 returns all calls to Jev; 1 selects Clef for all calls. Clef requires
`model: "clef"` in its body and is priced from its registry rate while absent
from the pinned Rust catalog. Both models keep the existing 254-candidate and
32,000-byte input bounds; oversized rosters still use the chat overflow tier.

Each feature's tier is declared once in `apps/web/src/server/ai/features.ts`.
Chat and embedding models derive from that tier; decision calls sample the
trial model as described above. Retier a feature only on live-eval
evidence: `pnpm --dir apps/web eval:features` (opt-in, billed) places the
production purchase-import audit, extraction-repair, and recipe-flow prompts
through the Gateway as each candidate, with the production schema, validator,
and repair turn, and scores synthetic cases correct, unsafe, or reviewable
miss with token cost. `FEATURE_EVAL_FEATURES` narrows to `audit`, `repair`, or
`recipe-flow`; `AGENT_EVAL_CANDIDATES` (for example `gpt-6-luna:xhigh`) and
`AGENT_EVAL_REPEATS` set the candidates and repeats. Each run writes its
revision, replay command, and results under `artifacts/feature-routing-eval/`.
The purchase coordinator's model is measured by `eval:purchase-decisions`
(see the purchase agent section).

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

Authenticated Start, workflow-stream, HTTP API, and MCP failures carry bounded
message/cause diagnostics with operation, optional entity, execution stage, and
request references. Credentials and Drizzle SQL/parameter wrappers are scrubbed;
pre-authentication failures expose safe messages and correlation IDs. Server
stacks stay in Sentry. The request-scoped reporter captures unexpected original
exceptions before returning the error, deduplicates nested reporting, and supplies
the actual event ID and an event-search link. An ID records a capture attempt,
not guaranteed ingestion. MCP batch items receive separate references.

Web error details include Copy details, the Sentry link, and Open Workers
Observability with a copyable Ray ID when Cloudflare supplied one. The Cloudflare
link opens the dashboard, not an individual trace: the custom-span API does not
expose the active trace ID. These references also survive native API decoding.

Source maps for `apps/web` are generated ("hidden" — emitted to disk but not
referenced by a `//# sourceMappingURL` comment) and uploaded at deploy by
`sentryTanstackStart` (`vite.config.ts`), under release `cubby@<short sha>` —
the same value the browser (`router.tsx`) and Worker (`cf-server.ts`) SDKs
report via `Sentry.init`/`withSentry`. Uploaded `.map` files are deleted from
`dist/` afterward so none are served as Worker static assets. Map sources are
rewritten to repo-relative paths (`apps/web/src/...`, `packages/*/src/...`) so
a single Sentry GitHub code mapping (repo root -> repo root on `main`) resolves
stack frames from both the client bundle and the Worker bundle. The upload needs a `SENTRY_AUTH_TOKEN`
secret, present only in the `deploy.yaml` workflow; PR/preview builds have no
token, so the plugin injects debug IDs and deletes the local maps but skips the
network upload. `SENTRY_IGNORED_ERRORS` (`apps/web/src/lib/sentry-noise.ts`)
lists known-noise messages dropped via `ignoreErrors` before Sentry ingests
them, so they never consume the free-plan error quota.

All four production Wrangler configurations persist traces in Workers
Observability with the current sampling rate. Cloudflare is the only trace
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

| Secret                    | Purpose                                                    |
| ------------------------- | ---------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`    | Deploy all four Workers and manage their declared bindings |
| `CLAUDE_CODE_OAUTH_TOKEN` | Automated Claude workflows, not application runtime        |

The Cloudflare token should be scoped to the checked-in account and only the
resource types the deployment workflow manages. Production deploys always
build before invoking Wrangler. Preview deploys are not supported; production
is the only deployed environment.

## Apple platform

The native targets use Xcode-managed signing and the associated domain
`cubby.nickysemenza.com`. The web Worker serves the Apple App Site Association
file. Purchase-import browser control additionally requires the checked-in
Apple Events entitlement and usage description; macOS grants Automation and
optional Screen Recording permission per local installation. There is no
hosted native deployment in this repository.

## Reconstruction and drift check

For a new account or disaster recovery:

1. Restore PostgreSQL and R2 before accepting writes.
2. Recreate auxiliary D1/R2 resources and deploy `usda-api`.
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
