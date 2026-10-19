# ChatGPT plan in Cubby

Cubby's open-source deployment can connect an eligible ChatGPT account to power
its Workers OpenAI Responses calls. Settings lists the account's displayable
model catalog from `GET https://api.openai.com/v1/models`, preserving OpenAI's
ordering and `visibility: "list"` rule. It has no model selectors: structured
tasks retain their declared models. Pi coordinators and Tester Army use the
explicit funding order in [Infrastructure](../infrastructure.md#claude-subscriber-credits):
Claude subscriber credits, ChatGPT subscription, then paid Unified Billing.
Other calls retain their existing fail-closed subscription behavior.

## Connect

1. Open Settings → ChatGPT plan → Continue with ChatGPT.
2. From a local checkout on your Mac, sign in to Cubby once if the CLI is not already signed in:

   ```sh
   pnpm apple cli auth login --base-url https://cubby.example.com
   ```

3. Run the command shown in Settings:

   ```sh
   pnpm apple cli chatgpt connect --base-url https://cubby.example.com
   ```

   The CLI reuses its stored Cubby credential. CubbyKit opens the system browser.
   Choose the ChatGPT account/workspace and allow plan usage.

4. Wait for the CLI to report Connected. The browser's “Authorization received”
   page only confirms the local callback; an exchange or persistence failure
   appears in the CLI and leaves setup incomplete.
5. Return to Settings and choose Check connection. Refresh models retrieves the
   live account catalog; Manage usage opens ChatGPT's usage controls.

The shared macOS CubbyKit flow runs an HTTP callback on `127.0.0.1` with state, nonce, and PKCE.
It obtains the deployment's persistent, opaque host ID before authorization.
First registration uses `dynamic_agent_client`; later authorization reuses the
issued client ID. Reauthorization sends the saved validated email as `login_hint`;
it never sends `id_token_hint`. When refresh removed `chatgpt.tokens.use.direct`,
the authorization-host response flags permission recovery and the CLI adds
`prompt=consent` to request that permission again. Ordinary sign-ins omit it;
`force_reconsent` is not confirmed for this integration. A state-validated `access_denied` callback reports
“You declined ChatGPT plan access.” without exchanging a code. It securely sends the authorization code and original verifier
through the generated `chatgpt.connect` operation. Workers exchanges the code, verifies the
signed ID token's issuer, audience, expiration, nonce and the originally registered account identity, checks the granted
plan scope, and persists the verified registration before probing model-catalog
access. A temporary catalog failure retains the renewable session and issued
client ID; Check connection and Refresh models can recover without another OAuth
registration.
No ChatGPT token is returned to the browser or saved by the CLI.
The Mac can close after setup; Workers owns refreshes.

The shared household connection lives in the `CHATGPT_PLAN` SQLite Durable
Object named `household`. Its RPC surface returns account status, models and
inference responses, never access or refresh tokens. The HTTP `chatgpt.connect`
operation calls the internal `authorizePlan` RPC because Cloudflare reserves
`connect` on Durable Object stubs for sockets. A real Workers regression test
checks that authorization reaches session validation across this boundary.
The session wraps native `fetch` rather than storing it as an object method:
Workers requires the global receiver. The same runtime regression exercises
token exchange with a synthetic upstream rejection to catch binding failures.
Concurrent refreshes are
serialized; the replacement access/refresh pair is persisted together before
use. Granted scopes are stored with the connection: an omitted refresh scope
retains that grant; an explicit refresh scope without `chatgpt.tokens.use.direct`
disables plan usage until reconnect. Previously stored connections already
passed this permission check and retain their original direct grant. No
PostgreSQL schema change or new environment secret is required.

After the first successful connection, Settings shows a dismissible note:
“Background AI work in Cubby uses your ChatGPT plan. Manage usage in ChatGPT
settings.” Got it persists on the shared connection, including across reconnects.
While connected, the card reads the current plan and paid caps from AI funding status: when the
plan usage limit or Cubby’s plan cap is reached, background work continues on
paid billing within the paid cap for the same six-hour window. `budget.ts` owns
those limits. A plan quota refusal without an OpenAI reset hint says that the
reset is unknown and offers Manage usage. Cubby may re-probe at its own window
boundary; that boundary is never presented as OpenAI’s reset time.

The existing ChatGPT Cubby MCP plugin authorizes ChatGPT to call Cubby. Its
Cubby-issued connector credential does not grant Cubby access to a ChatGPT plan;
this separate OpenAI authorization is still required.

## Requests, errors, and disconnect

Subscription calls go directly to `https://api.openai.com/v1/responses`, using
the OAuth access token. They set `store: false` and `stream: true`, resend the
conversation input, convert system messages to developer messages, and supply
function/custom tools as one developer `additional_tools` input item placed
right after the leading developer instructions, so the plan's prefix cache
covers the tool schemas instead of re-reading them after every new turn
(production cache reads confirmed the plan accepts that position). Each tool
result also carries an explicit `prompt_cache_breakpoint`: the plan's implicit
caching rarely reused a Run's growing conversation (5.6% of Sol's plan input
read from cache in October 2026, while an identical request on the paid API read
nearly all of it). The preview documents neither support nor refusal of
breakpoints, so an HTTP 400 `invalid_request_error` naming `input` (or
`prompt_cache_breakpoint`) retries the request once without them, logs the
refusal, and the plan Durable Object keeps sending none while it lives; quota
and rate refusals never trigger it. Compare `AiUsage.cacheReadTokens` on
`transport = 'chatgpt'` rows before and after a deploy to judge the effect, and
remove the guard once plan calls succeed with breakpoints. Unsupported preview
parameters are removed. Unsupported hosted tools fail before inference.
pi-ai carries reasoning effort for gpt-6 models as `configuration_update` input
items unless it sees the direct OpenAI base URL, which Cubby's gateway
placeholders hide; subscription sharing refuses those items with HTTP 400
`subscription_sharing_unsupported_capability`, so the adapter drops them and
sends the latest one's effort as `reasoning.effort`.
The existing application response cache still serves valid identical results.
Caller cancellation propagates to the inference owner through request IDs,
including after streaming starts. Calls have a five-minute maximum deadline;
a shorter configured gateway deadline wins.
Subscription usage retains a zero incremental charge and a separate standard
API comparison when pricing evidence is available. [AI cost accounting](ai-cost-accounting.md)
owns billing evidence, historical reconstruction, totals, and display precision.
Embeddings, Workers AI and Anthropic keep their existing transport and billing.

### Usage attribution

Every `AiUsage` row names its `transport` (`aiUsageTransportValues` in
`packages/schemas/src/telemetry.ts`): `gateway`, `chatgpt`, `direct`, `cache`
or `unknown`. The transport is selected before the request leaves
(`GatewayCallOptions.onTransport`, the agent's `onSelected`), so a connected
plan's failure — even one that throws before any HTTP response — records a
failed `chatgpt` row. Only callers with an explicit funding fallback policy
advance recognized plan refusals to the paid gateway: a quota 429, or a 400
`subscription_sharing_unsupported_capability` for a request the plan cannot carry. The
telemetry writer records plan coverage for every `chatgpt` row while retaining
its token evidence and standard-price comparison. A failed row's `failure`
column keeps the provider's status and body (or the error text), scrubbed by
`scrubErrorMessage` and bounded to 2,000 characters, including a refusal the
funding ladder recovered from. The plan's Durable Object also logs each non-OK
response as `plan refused inference` (scope `chatgpt-plan`) in Workers
observability. `cache` means an application replay with no upstream call (the
application response cache or a stored `AiAnalysis`); a Gateway response-cache
hit still went through the gateway and stays `gateway`. Failed attempts record
a failed row on their selected transport, keeping a billed response's usage
when only its validation failed.

Rows written before the column existed stay `unknown` unless they carry
positive evidence: the migration set `cache` for an application-cache hit and
`gateway` for a non-empty `gatewayLogId`. Zero cost and a caller-cache `hit`
are not evidence (a prompt-cache read also wrote `hit`), so neither is guessed.
The column keeps `DEFAULT 'unknown'` for writers deployed before it and queued
telemetry minted without the field.

The AI usage page uses Cubby's shared RTable for summaries and recent calls.
Recent calls filter by transport, status, provider, model, feature, and search
text. Filters apply to the full history before taking the newest requested
number of calls; changing the summary's date window does not restrict recent
calls. Provider, model, and feature choices come from all non-deleted call
history, independently of summary windows and recent-call limits. Search
matches feature, model, or operation. Refresh recent calls reloads both calls
and their filter choices.

OpenAI eligibility, region, revoked-session and usage-limit errors are surfaced
with credential-shaped values scrubbed. Before a stream opens, HTTP 503
(including `subscription_sharing_usage_unavailable` and
`subscription_sharing_user_unavailable`) retries the same plan request at 2, 8,
and 30 seconds, subject to caller cancellation and the request deadline. One
retry budget covers both the original and breakpoint-stripped requests. If the
next delay cannot fit the remaining deadline, Cubby returns the last 503 body
without waiting; exhausted retries also return that refusal to the existing funding ladder. No started stream is replayed.
Agent/coordinator calls treat `response.incomplete` as failure; the separate
Rust structured-extraction forwarder retains incomplete output and usage for
its truncation recovery.

Temporary refresh errors preserve credentials. Terminal refresh errors clear
unusable tokens and show Reconnect ChatGPT. `invalid_client` also forgets the
issued client ID and explains that OpenAI no longer accepts Cubby’s registration.
The authorization-code exchange applies the same recovery when a saved client
is rejected at connect time.
The host ID and verified subject stay: fresh dynamic registration may replace
the rejected client ID only for that same subject. A 403
`subscription_sharing_user_not_eligible` or 401 `subscription_sharing_invalid_user`
stops further plan use and shows the provider diagnostic plus a recovery
explanation until an explicit reconnect; Cubby never loops through OAuth.
A connected plan needing reauthorization (including removed permission or a
rejected registration) is skipped just like a disconnected plan: funding
ladders advance to their next source, ordinary callers use their existing paid
route, and subscription-only callers fail closed with `subscription_unavailable`.
Settings explains that fallback and omits the unavailable model catalog.

Disconnect ChatGPT attempts renewable-session revocation, retrying network and
5xx failures at 2, 8, and 30 seconds within a bounded deadline. Local tokens are
cleared even when revocation cannot be confirmed; the client mapping, account
identity, and host ID remain. Settings then says: “Cubby cleared its tokens but
couldn't confirm OpenAI revoked them; disconnect Cubby in ChatGPT settings to be
sure.” The persisted warning includes the raw failure diagnostic with only
credential-shaped values scrubbed. Discovery parse errors, unexpected endpoint
origins, and 4xx refusals fail immediately; only network and 5xx failures retry.
Dismiss warning clears it on the shared connection, and the next successful
connect also clears it. An explicitly disconnected deployment resumes its
existing paid AI Gateway route.

## Availability and verification

OpenAI documents remotely running open-source tools on self-hosted VMs, while
its overview separately directs remotely hosted apps to an interest form.
Workers is not explicitly covered. This integration uses the documented OAuth
and public Responses route; it does not establish OpenAI approval for every
hosting arrangement or account. A successful live connection and completed
inference must be verified for the intended deployment before claiming it works.

Automated checks use synthetic external account responses. They verify token
rotation and persistence, request shaping, and settings behavior; they do not
prove live subscription eligibility. Live setup requires a person to consent.
Keep credentials and account data out of screenshots, artifacts and logs.

Primary references:

- [Overview](https://developers.openai.com/siwc/token-sharing-open-source)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Self-hosted VMs](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
