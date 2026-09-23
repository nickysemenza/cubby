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

| Concern                       | Provider                           | Production resource                                                                   |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| Web application and APIs      | Cloudflare Workers                 | Worker `cubby`, custom domain `cubby.nickysemenza.com`                                |
| Purchase-import orchestration | Cloudflare Workers + Flue          | Private Worker `purchase-agent`, queue `cubby-purchase-agent`, SQLite Durable Objects |
| PostgreSQL                    | Neon through Cloudflare Hyperdrive | One Neon origin, two Hyperdrive configurations                                        |
| Images and documents          | Cloudflare R2                      | Bucket `foo`, public origin `https://media.nickysemenza.com`                          |
| Product lookup                | Cloudflare Workers                 | Worker `upc-lookup`, D1 `upc-lookup-db`, R2 `upc-images`                              |
| USDA food data                | Cloudflare Workers                 | Worker `usda-api`, D1 `usda-api-index`, R2 `usda-api-bundles`                         |
| AI routing                    | Cloudflare AI Gateway              | Gateway `cubby`, Workers AI binding `AI`                                              |
| Semantic vectors              | Cloudflare Vectorize               | `cubby-openai-text-embedding-3-small-1536`                                            |
| Gmail discovery               | Google Cloud                       | Project `cubby-481519`, Gmail API, OAuth web client                                   |
| Errors                        | Sentry                             | Web/Workers project represented by the checked-in DSN; separate `cubby-apple` project |
| Worker logs and traces        | Grafana Cloud                      | Cloudflare OTLP destinations `grafana-logs` and `grafana-traces`                      |
| Deployment                    | GitHub Actions                     | `.github/workflows/deploy.yaml` on `main`                                             |
| Native clients                | Apple Developer/Xcode              | Associated domain `cubby.nickysemenza.com`; locally installed iOS/macOS apps          |

The checked-in provider configurations are:

- [`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc)
- [`apps/purchase-agent/wrangler.jsonc`](../apps/purchase-agent/wrangler.jsonc)
- [`apps/upc-lookup/wrangler.jsonc`](../apps/upc-lookup/wrangler.jsonc)
- [`apps/usda-api/wrangler.jsonc`](../apps/usda-api/wrangler.jsonc)
- [`.github/workflows/deploy.yaml`](../.github/workflows/deploy.yaml)

## Cloudflare

Account ID: `9f10f078d35d86c78dedece2300a6b88`.

### Main Worker

`apps/web/wrangler.jsonc` declares the reproducible part of Worker `cubby`:

- Custom domain `cubby.nickysemenza.com`; `workers.dev` production routing is
  disabled and preview URLs are enabled.
- Smart Placement and static assets.
- Service bindings `USDA_API` -> `usda-api`, `UPC_LOOKUP` -> `upc-lookup`, and
  `PURCHASE_AGENT` -> the private `purchase-agent` Worker. The reverse named
  `CUBBY_PURCHASE_SERVICE` binding carries database-authoritative MCP and import
  operations; neither direction uses a public Worker URL.
- SQLite Durable Objects `DatabaseFreshnessDurableObject`,
  `CalendarFeedDurableObject`, and `PurchaseImportDurableObject`.
- Workflow `cubby-search-index-repair`.
- Queues `cubby-background` and `cubby-telemetry`, plus producer-only
  `cubby-purchase-agent`, with settings in the Wrangler files.
- One daily cron trigger at 12:00 UTC; authenticated app openings enqueue
  catch-up work with a household-wide one-hour cooldown.
- Workers AI binding `AI` and AI Gateway `cubby`.
- Vectorize binding `VECTORIZE` ->
  `cubby-openai-text-embedding-3-small-1536`, dimensions `1536`, cosine metric,
  with string metadata index `entityType`.
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

### Private purchase-agent Worker

`apps/purchase-agent` is the private Flue runtime for purchase imports. It has
no route, preview URL, database credential, document binding, or browser
authority. Its checked-in Wrangler configuration declares:

- queue consumer `cubby-purchase-agent`;
- SQLite Durable Object class `FlueImportRunAgent`, one instance named
  `import-run:<ImportRun.id>` per run;
- direct named service binding `CUBBY_PURCHASE_SERVICE` to the web Worker's
  `PurchaseImportService` entrypoint, including run-bound MCP token issuance
  and private MCP request forwarding;
- Workers AI binding `AI`, with every orchestration call routed through AI
  Gateway `cubby` by the Flue provider adapter;
- vars `SENTRY_ENVIRONMENT` (`test` disables Sentry entirely, which is what the
  workerd harness sets) and `SENTRY_TRACES_SAMPLE_RATE` (Flue agent-tracing
  spans sent to Sentry; `1` in production).

Observability on this Worker has two backends. Native Workers Traces carry the
platform spans plus Flue's `invoke_agent` / `chat` / `execute_tool` spans and the
consumer's `job.purchase_agent_event` span (`run.id`, `event.type`,
`dispatch.outcome`) to Grafana Tempo; `app.ts` installs that instrumentation
explicitly with `content: false`, because Flue's default install would attach
prompts, tool arguments, and results as span attributes. Sentry is wired by
`src/sentry.ts`, a port of Flue's official `tooling/sentry` blueprint: the agent
Durable Object class is wrapped with `instrumentDurableObjectWithSentry`, the
queue consumer with `withSentry`, and both report to the shared `cubby` project
tagged `service:purchase-agent`. Sentry receives the same span hierarchy with
token usage, Flue `log.*` calls as Sentry Logs, terminal failures (a failed
top-level agent operation or a failed submission settlement) as issues, and
coordinator recovery as breadcrumbs. Model and tool content is never recorded on
either backend.

The web Worker has the reverse `PURCHASE_AGENT` service binding solely to proxy
authenticated conversation history, live updates, prompts, and aborts. This is
a bounded circular service topology, not a recursive request loop: queue events
start agent work, agent MCP calls return through `PurchaseImportService`, and
browser users reach the agent only through an authenticated web route.

Account syncs and explicit Purchase validation/Product enrichment runs share
the same queue. Each admitted run records a stable start-event id and the
consumer fences duplicates and late deliveries before Flue admission. A
VendorAccount never has more than one active run: targeted launches reject a
busy account and link to its `PIR-*` page instead of creating an application
waiting queue. Run-scoped evidence is stored beneath the import-run R2 prefix
and remains separate from shared Image and Purchase document records.

The fixed public OAuth client id is `cubby-purchase-agent`. It uses authorization
code + PKCE, `offline_access`, no client secret, and the callback
`https://cubby.nickysemenza.com/api/import/agent/oauth/callback`. The web Worker
provisions the client idempotently when authorization begins. Better Auth's
existing `oauth_refresh_token` row is the revocable grant; its value is never
copied to Flue. The web Worker mints five-minute, run-bound delegation tokens
for MCP calls and rechecks the live grant and LedgerParty ownership on every
request.

Create and verify the non-route resource before the first deploy:

```bash
pnpm --dir apps/web exec wrangler queues create cubby-purchase-agent
pnpm --dir apps/web exec wrangler queues list
pnpm --dir apps/purchase-agent run build
pnpm --dir apps/purchase-agent exec wrangler deploy --dry-run
```

Deploy `cubby` first whenever `PurchaseImportService` changes, then deploy
`purchase-agent`. The GitHub workflow preserves that order; agent-only changes
skip the web deploy. Verify the private Worker and bindings with:

```bash
pnpm --dir apps/purchase-agent exec wrangler deployments list
pnpm --dir apps/purchase-agent exec wrangler tail
```

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

The deterministic fixture suite is local and free. The live Terra gate drives
the deployed authenticated Flue conversation itself, then reads the fixture
result endpoint and applies the same prohibited-call, Product-reuse,
idempotency, and final-state assertions:

```bash
pnpm --dir apps/purchase-agent eval:fixture
PURCHASE_AGENT_EVAL_AGENT_URL='https://cubby.nickysemenza.com/api/import/runs/PIR-XXXXXXXXXX/agent' \
PURCHASE_AGENT_EVAL_RESULT_URL='<authenticated-fixture-result-url>' \
PURCHASE_AGENT_EVAL_SESSION_COOKIE='REDACTED' \
  pnpm --dir apps/purchase-agent eval:live
```

The live gate requires a deliberately provisioned fixture run and an
authenticated household session. Never save the session cookie in shell
history, CI logs, repository files, or Flue messages.

Rollback is additive: pause the `cubby-purchase-agent` consumer and deploy the
previous web and Apple versions. Postgres import rows and the retained
`PurchaseImportDurableObject` namespace remain compatible.

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

The auxiliary Workers use native R2 bindings:

- `upc-lookup`: binding `IMAGES`, bucket `upc-images`.
- `usda-api`: binding `USDA_BUNDLES`, bucket `usda-api-bundles`.

Cloudflare DNS and the R2 custom-domain configuration must route
`media.nickysemenza.com` to the main bucket. Image delivery depends on
Cloudflare Image Resizing at that origin.

### D1 and auxiliary Workers

| Worker       | D1 database      | Database ID                            | Other state                              |
| ------------ | ---------------- | -------------------------------------- | ---------------------------------------- |
| `upc-lookup` | `upc-lookup-db`  | `6c1f2074-2017-48d1-ae37-bc7002d47c64` | R2 `upc-images`; Worker secret `API_KEY` |
| `usda-api`   | `usda-api-index` | `e2e0037c-6046-4b66-85d9-03ceb0770db6` | R2 `usda-api-bundles`                    |

D1 migrations live beside each Worker and are an explicit operator step; the
package deploy scripts do not apply them:

```bash
pnpm --filter @cubby/upc-lookup run db:migrate:remote
pnpm --filter @cubby/usda-api run edge:d1:migrate:remote
```

Apply a compatible migration before deploying code that requires it. The main
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
| `API_KEY`              | `upc-lookup` Worker secret     | Direct access to the UPC lookup Worker                  |

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
one trace, so the web Worker's proxy into the purchase agent and the agent's
`CUBBY_PURCHASE_SERVICE` calls back appear in a single trace in the Cloudflare
dashboard and in Tempo. A queue delivery starts a new trace in the consumer;
`run.id` on the consumer's job span is the join key back to the producer's job
spans. Trace context never propagates to services outside Cloudflare.

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

Cloudflare must have two account-level Workers Observability destinations:

- `grafana-logs` -> Grafana Cloud Loki OTLP endpoint.
- `grafana-traces` -> Grafana Cloud Tempo OTLP endpoint.

All four production Wrangler configurations reference those exact names and
persist their logs and traces for investigation in Workers Observability.
The calendar-test Worker is intentionally excluded: it is a local test
harness and must not export test traffic to the production destinations.
Destination credentials live in Cloudflare, not GitHub or this repository.

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
2. Recreate auxiliary D1/R2 resources and deploy `usda-api` and `upc-lookup`.
3. Recreate Hyperdrive, queues, Vectorize, AI Gateway/provider access, and
   observability destinations; update checked-in IDs if they changed.
4. Restore Worker and GitHub secrets through their providers.
5. Recreate Google Auth Platform configuration and rotate the Google client
   secret rather than copying it through documentation.
6. Deploy `cubby`, then the private `purchase-agent`; verify their exact source
   revision, queue/service binding, Flue storage, Gateway usage, and run
   authenticated database, media, AI, Gmail, and auxiliary-service smoke tests.
7. Reconnect native clients and regrant local macOS permissions.

Before deleting apparently unused provider state, search the repository, check
provider usage/audit logs, and confirm that it is absent from current deployed
bindings. A resource being absent from this file is evidence of drift, not by
itself authorization to delete it.
