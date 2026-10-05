# AI Gateway consolidation: research notes

Question: should production (`cubby`), the tester army (`cubby-testing`), and
the unexplained `default` gateway consolidate on `cubby`, and should
high-cardinality metadata such as `chunk` and `batchId` be removed?

Sources: official Cloudflare docs only, fetched 2026-10-05 as Markdown from
<https://developers.cloudflare.com/ai-gateway/llms.txt>. Most pages show a
"Last updated" date of 2026-09-15 to 2026-10-02. No account data, dashboards,
or screenshots were used. This note doesn't check what Cubby sends today. The
parent traces the repository separately.

Each section separates what the docs **confirm** from what they **don't say**.
The recommendation is at the end and is clearly labelled.

## 1. User Insights

Confirmed:

- User Insights is free and uses existing gateway traffic with no setup.
  Requests without an identity or custom metadata are grouped "under a single
  anonymous identifier". Usage is attributed to users "with custom metadata"
  or with Cloudflare Access.
  [User Insights](https://developers.cloudflare.com/ai-gateway/observability/user-insights/)
- Anomaly detection works per **session**, not per request. A session is
  flagged when its cost is above 2× the user's 30-day p95 session cost **and**
  above the organization-wide p99 session cost. Flagging never blocks
  requests. The user view counts "Sessions: Approximate session count from
  request metadata". [User Insights](https://developers.cloudflare.com/ai-gateway/observability/user-insights/)
- Task and model-fit analysis needs **Log classification**. It's off by
  default, has to be turned on for each gateway, needs **Collect logs**, and
  may process prompts, responses, request metadata, and conversation
  identifiers.
  [Log classification](https://developers.cloudflare.com/ai-gateway/observability/log-classification/),
  [changelog 2026-09-29](https://developers.cloudflare.com/ai-gateway/changelog/)
- With Access, the verified identity is saved as reserved metadata
  `cf.user_id`, which is the JWT `sub`. Clients can't set `cf.*` keys.
  [Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/#reserved-metadata)

Not documented:

- The docs **don't say** that User Insights can group by an arbitrary metadata
  key you choose. They also don't say which key name counts as the user
  identifier, which keys mark a session, or whether User Insights can be
  filtered by gateway. Don't assume a `batchId` or `environment` breakdown
  exists there.
- They don't give a cardinality limit for User Insights identities.

## 2. Custom metadata limits

Confirmed:

- Each request can carry **5 entries**. Only the first five are saved and the
  rest are ignored. Values can be strings, numbers, or booleans, not objects.
  [Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/),
  [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- If a request already has five entries and arrives through Access, AI
  Gateway "may remove the last custom entry" to make room for `cf.user_id`.
  [Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/#reserved-metadata)
- Logs can be filtered by metadata key and value (equals / not equals).
  [Legacy Logs](https://developers.cloudflare.com/ai-gateway/observability/logging/legacy-logs/)
- On the Worker binding, the `metadata` option and `gateway.patchLog()` can
  attach metadata to a log entry, and `env.AI.aiGatewayLogId` returns the log
  ID. [Workers bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)

Not documented: any limit on distinct values per key, or any per-value cost.
The documented costs of high-cardinality keys are therefore indirect: they use
up some of the five slots, and they create spend-limit buckets (section 5).

## 3. Analytics vs logs, and retention

Confirmed:

- The dashboard analytics show requests, tokens, costs, errors, and cache
  rate. The documented GraphQL dataset is `aiGatewayRequestsAdaptiveGroups`,
  and its example dimensions are `model`, `provider`, `gateway`, and
  `datetimeMinute`.
  [Analytics](https://developers.cloudflare.com/ai-gateway/observability/analytics/)
- The spend-limits page says spend can be tracked "per model, provider, or any
  custom metadata attribute on the Analytics dashboard".
  [Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/#monitoring-spend)
- GraphQL adaptive datasets keep at least 31 days of data on every plan.
  [GraphQL limits](https://developers.cloudflare.com/analytics/graphql-api/limits/)
  (Applying this to the AI Gateway dataset is an inference from its
  `Adaptive` name. The AI Gateway pages don't state analytics retention.)
- Logs are on by default for each gateway. They can be overridden per request
  with `cf-aig-collect-log`. `cf-aig-collect-log-payload: false` keeps the
  metadata (tokens, cost, model, status, duration) and drops the bodies.
  [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- Log retention depends on **when the account created its first gateway**:
  - First gateway **on or after 2026-09-24**: Workers Logs pricing and
    retention apply. That's 3 days on Free and 7 days on Paid (20M events a
    month included, then $0.60 per million).
    [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/),
    [Workers Logs limits/pricing](https://developers.cloudflare.com/workers/observability/logs/workers-logs/#limits)
  - First gateway **before 2026-09-24**: Legacy Logs apply. Logs are kept
    until deleted. Paid accounts can store **10M logs per gateway**, Free
    accounts 100k per account. Writes are capped at 500 logs/s per gateway and
    10 MB per log. At the limit, Legacy Logs either stops saving or deletes the
    oldest logs automatically.
    [Legacy Logs](https://developers.cloudflare.com/ai-gateway/observability/logging/legacy-logs/),
    [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- Logpush is limited to 4 jobs per account and 1 MB per log, and it's
  encrypted. [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/),
  [Logpush](https://developers.cloudflare.com/ai-gateway/observability/logging/logpush/)

Not documented: whether the analytics metadata breakdown is limited by
cardinality, or how long it's kept. Which retention regime applies to Cubby's
account depends on account history, which this note doesn't inspect.

## 4. Caching namespace

Confirmed:

- Caching is off by default. It can be turned on per gateway or for a single
  request with `cf-aig-cache-key`. TTL runs from 60 s to 1 month, and
  cacheable requests can be up to 25 MB.
  [Caching](https://developers.cloudflare.com/ai-gateway/features/caching/),
  [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- The default cache key is a SHA-256 of **provider + endpoint + model +
  provider auth header + full request body**. `cf-aig-cache-key` replaces
  that key, and "requests with the same custom key share a cached response".
  The cache is volatile, so two simultaneous identical requests can both miss.
  [Caching](https://developers.cloudflare.com/ai-gateway/features/caching/#how-the-cache-key-works)
- The binding exposes `skipCache`, `cacheTtl`, and `cacheKey`.
  [Workers bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)

Not documented: the **gateway ID isn't listed** in the cache-key inputs, and
the docs don't say whether the cache is scoped to a gateway or to the account.
Metadata is also not part of the documented default key. If testing and
production traffic share a gateway, assume that identical requests, or the
same custom key, can return each other's cached responses.

## 5. Spend limits

Confirmed:

- Spend limits are cost budgets over a rolling or fixed window. When a budget
  is exceeded the gateway returns `429`. Enforcement is eventually consistent,
  so concurrent bursts can overshoot. Cost is a best-effort estimate. The
  limit is **20 rules per gateway**.
  [Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- A rule can be scoped by provider, model, and/or a metadata key. Each
  dimension either **splits by value** (one budget bucket per distinct value)
  or **filters by value** (the rule only applies when the value matches). A
  dimension that isn't configured shares one bucket.
  [Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/#scoping-with-dimensions)
- Spend limits apply to both Unified Billing and BYOK requests for models with
  known pricing. Pairing one with a Dynamic Route lets requests fall back to
  another model instead of being blocked.
  [Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/#behavior-when-a-limit-is-reached)

What this implies: splitting by `batchId` or `chunk` would give every batch
its own budget, which is meaningless. Splitting or filtering by a
low-cardinality key such as `environment` gives the tester army its own
budget, even inside a shared gateway.

## 6. Dynamic routes and metadata conditions

Confirmed:

- Conditional nodes take MongoDB-like expressions (`$eq`, `$ne`, `$in`,
  `$and`, `$or`) over the request body, headers, or `metadata.*`. Percentage
  nodes allow at most 5 outputs. Rate and budget nodes take a `key` such as
  `metadata.user_id`, a `limitType` of `count` or `cost`, a `limit`, a
  `window`, and an optional fallback.
  [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/),
  [JSON configuration](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/json-configuration/)
- Dynamic routes accept **only the OpenAI chat-completions shape**. Anthropic
  Messages requests return `400`. Routes belong to one gateway and aren't
  shared. On the REST API, a request without `cf-aig-gateway-id` resolves
  against the **default** gateway and returns `404`. Setup requires an
  authenticated gateway with provider keys stored through BYOK.
  [Dynamic routing](https://developers.cloudflare.com/ai-gateway/features/dynamic-routing/),
  [Workers bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)

Not documented: a maximum number of conditions, routes, or distinct
rate/budget key values per route.

## 7. Rate limiting

Confirmed:

- Gateway rate limiting is one setting for the whole gateway: a request count
  per period, using a fixed or sliding window. It "will be uniformly applied
  to all requests for that gateway" and returns `429` when exceeded. The page
  documents no metadata or per-caller scoping.
  [Rate limiting](https://developers.cloudflare.com/ai-gateway/features/rate-limiting/)
- Unified Billing requests are separately limited to **200 requests per 60 s
  per gateway**. BYOK requests aren't subject to this limit.
  [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)
- Per-key request limits are available only through Dynamic Route rate nodes
  (section 6).

What this implies: in a shared gateway, a burst from the tester army uses up
the same gateway-wide rate limit as production. The 200/60 s Unified Billing
budget is shared too.

## 8. Authentication, BYOK, and scoping

Confirmed:

- AI Gateway token permissions (`Read`, `Run`, `Edit`) **are account-scoped
  and can't be limited to one gateway**. Any `Run` token can call every
  gateway and use its stored BYOK keys. For real isolation the docs recommend
  separate accounts or a Worker binding.
  [Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)
- REST `/ai/*` calls need the **Workers AI Read** permission. A token with
  only AI Gateway permissions gets `401`.
  [REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/#authentication)
- BYOK keys are stored **per gateway**. Secrets created through the API must
  be named `{gateway_id}_{provider_slug}_{alias}`. On the binding and Unified
  endpoints, only the `default` alias is used, and any other alias falls
  through to Unified Billing. `cf-aig-byok-alias` only works on
  provider-passthrough endpoints.
  [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/),
  [Unified Billing — credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/#credential-precedence)
- Credentials are resolved in this order: a provider key on the request, then
  a stored BYOK `default` key, then Unified Billing. A per-gateway setting,
  **Require provider credentials** (`byok_only`), returns `400` instead of
  falling through to Unified Billing.
  [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/),
  [changelog 2026-09-14](https://developers.cloudflare.com/ai-gateway/changelog/)
- Access protection works per gateway through a custom domain and adds
  `cf.user_id`. Service tokens don't get `cf.user_id`.
  [Cloudflare Access](https://developers.cloudflare.com/ai-gateway/configuration/cloudflare-access/)

What this implies: separate gateways give **no security isolation**. They
only separate configuration (settings, keys, limits, routes, and log storage).

## 9. The automatic `default` gateway

Confirmed:

- If the gateway ID is omitted, AI Gateway uses `default`. If no gateway by
  that name exists, the first authenticated request creates one with these
  settings: authentication on, logs on, caching off, rate limiting off,
  require-provider-credentials off, and standard Workers AI billing. Deleting
  it doesn't stop it from coming back: the next authenticated request
  recreates it. No other gateway ID is created automatically.
  [Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/#default-gateway)
- On the REST API, third-party model requests go to the account's default
  gateway unless `cf-aig-gateway-id` is set. Workers AI `@cf/` requests always
  need that header.
  [REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/),
  [changelog 2026-05-21](https://developers.cloudflare.com/ai-gateway/changelog/)
- On the binding, `gateway.id` is listed as required, and `"default"`
  triggers auto-creation.
  [Workers bindings](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)
- New Web Search API examples use gateway `default`.
  [changelog 2026-10-02](https://developers.cloudflare.com/ai-gateway/changelog/)
- Account limits are 10 gateways on Free and 20 on Paid, with names up to 64
  characters. [Limits](https://developers.cloudflare.com/ai-gateway/reference/limits/)

What this implies: an "unknown default" gateway most likely comes from a REST
call without `cf-aig-gateway-id`, or from a caller that passes `"default"`.
Deleting the gateway alone won't remove it. Every caller has to name its
gateway explicitly first.

## Accepted decision

Use `cubby` for all billed application, synthetic testing, evaluation, and
integration-enabled development traffic. Accept the shared 200 requests per
60 seconds Unified Billing allowance. `environment`, `feature`, and `operation`
provide stable attribution, with optional `entityKind`. Keep identifiers,
chunk numbers, paths, revisions, input counts, and model-pricing details in
application accounting and traces. Preserve accounting before filtering the
outbound metadata. Synthetic testing bypasses the response cache.

Every request must name its gateway explicitly. Retire `default`; once all
callers have moved, retire the separate testing gateway. Gateway deletion
permanently removes its configuration and stored logs, and deleting `default`
does not prevent a caller without an explicit gateway ID from recreating it.
[Manage gateways](https://developers.cloudflare.com/ai-gateway/configuration/manage-gateway/)

This is an operational simplification, not a security boundary: gateway tokens
remain account-scoped. CI spend rules may filter on `environment=ci`, but
metadata budgets do not isolate the shared request allowance.
[Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/),
[Authenticated Gateway](https://developers.cloudflare.com/ai-gateway/configuration/authentication/)

## Limits of this research

- Only docs. No account state, dashboard, or GraphQL schema introspection, and
  no requests sent.
- The docs don't settle: whether the cache is scoped per gateway, which
  metadata key User Insights uses for identity and sessions, whether User
  Insights can group by arbitrary keys, how long AI Gateway analytics are
  kept, or any metadata cardinality limits.
- The changelog index page says "Last updated Jun 5, 2026" but contains
  entries through 2026-10-02. Entries were read directly.
