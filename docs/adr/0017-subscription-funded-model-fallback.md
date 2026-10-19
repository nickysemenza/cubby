# ADR 0017: Subscription-funded model fallback

Status: Amended. The funding and gateway amendment supersedes the original design for Pi agents and Tester Army; the background-work amendment narrows it for background Runs.

Production chat runs on the household's ChatGPT plan (Luna and Sol at ~$0
marginal cost); Anthropic is nearly unused. An eligible Claude Max or Team plan
includes [monthly Claude API credits](https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers)
that cover the Claude API and Agent SDK, but not Claude Code, and expire each
cycle. Use those credits as a second subscription-funded capacity pool. A
feature declares an ordered list of chat models; Cubby advances to the next
only when the current one's subscription capacity is exhausted. No step ever
falls back to paid API billing: when every listed model is exhausted, the call
fails with the provider's raw diagnostics.

This replaces the ChatGPT plan rule "a connected account never silently falls
back to paid API billing" with the broader rule: fall back only between
subscription-funded models, never to paid billing.

## Credential and routing

- One Claude Console organization exists only for Cubby; the plan links to it
  once and the link cannot be changed without support.
- Two workspaces, `prod` and `testing`, each with a Console spend limit. Their
  sum stays slightly below the monthly credit, with roughly a quarter for
  `testing`, so live evals cannot drain production's month. Purchased credits
  and auto-reload stay off, so every successful call on the key is
  credit-funded.
- Each workspace's API key is the `default` stored (BYOK) key in its AI Gateway
  (`cubby`, `cubby-testing`). Anthropic requests send `cf-aig-no-wholesale:
  true`, so a missing key fails instead of falling through to Unified Billing.
  Embeddings and other routes keep Unified Billing.
- Stored-key traffic is exempt from Unified Billing's 200 requests/60 s gateway
  limit, so the egress Durable Object admits it under its own billing bucket.

## Fallback

Exhaustion errors that advance to the next model:

- Anthropic credit balance too low (undocumented; matched on message text).
- Anthropic workspace or organization spend limit reached (400, "reached your
  specified … API usage limits").
- Anthropic 429, including `enforced_spend_limit_reached`, which has no
  `retry-after` and must not be retried as an ordinary rate limit.
- ChatGPT plan rate-limited, restricted, or disconnected.

Any other error fails as today. The usage row and the analysis record the model
that actually answered, so a fallback is visible in provenance and cache keys.

Which model leads for a feature is decided by evidence:
`feature-routing-eval.live-eval.ts` gains Sonnet 5 and Opus 5.5 on the testing
workspace, and a feature leads with Claude only where it clearly wins. Tiers
remain the default source of a feature's list.

## Accounting

A new `subscriber_credit` billing reason records `chargedCost = 0` and keeps
the standard API comparison cost, so the AI usage page shows Claude credit
spend by grouping on billing reason. No credit counter or renewal-day
configuration exists: the API exposes no promotional balance, the Console
spend limit enforces the cap, and the Console Billing page shows balance and
expiry.

## Consequences

- At exactly a $200 monthly credit the Console organization rises only to the
  Start usage tier; its low per-minute limits make bulk background calls hit
  429s, which this design treats as exhaustion and routes back to the ChatGPT
  plan.
- Console spend limits reset on the 1st of each month, while credits refresh on
  the plan's billing date, so the limit is set slightly below the credit.
- Claude Code sessions and automated Claude workflows
  (`CLAUDE_CODE_OAUTH_TOKEN`) are not funded by these credits.

## Considered options

- **Fall back to Unified Billing** when credits run out: rejected; it
  reintroduces paid spend the household does not currently incur.
- **Store the key under a named alias and retry without it**: only needed for
  a paid fallback; rejected with it.
- **Retier the whole quality tier to Claude**: superseded by per-feature,
  eval-gated ordering, which reaches the same result where Claude wins
  everywhere.
- **Unattended Agent SDK burn-down** of research or purchase import: rejected;
  it conflicts with the "rare interactive work stays interactive" tenet and
  [ADR 0010](0010-mail-import-unattended-burn-down-interactive.md).
- **A Cubby-side credit counter with a configured renewal day**: rejected in
  favor of the Console spend limit plus billing-reason grouping.

## Funding and gateway amendment

Every tier-routed chat call (Pi coordinators, Tester Army and structured
feature runs, including Mail import) consumes the Claude subscriber credit pool
first on Opus, then Sol on the existing ChatGPT subscription, then paid Sol
through Cloudflare Unified Billing. One ladder serves every tier: the credit
costs nothing at the margin, so a separate fast path saves nothing. Paid fallback
is explicitly authorized so exhaustion does not stop useful work; callers that
require the subscription stop before paid unless their fallback is budgeted. A
plan refusal of an unsupported request is a funding refusal, so it advances the
ladder. Fixed-model evaluation calls and explicit model overrides remain fixed so
comparisons still measure the requested model.

Use one gateway, `cubby`, for all billed production, local, CI and evaluation
traffic. Environment metadata preserves attribution; shared gateway capacity is
an accepted tradeoff for one credential setup. The previous testing-gateway
split and testing allocation are superseded. Gateway credentials remain
account-scoped and never made that split a security boundary.

The subscriber key uses the named `subscriber-credit` BYOK alias, with
`cf-aig-no-wholesale: true`. Leave the default Anthropic key unset so an
unaliased paid request uses Unified Billing. Console workspace limits enforce
credit-route capacity; promotional balance is not exposed to Cubby. Setup and
billing-cycle limitations live in [Infrastructure](../infrastructure.md#claude-subscriber-credits).

Quota fallback discards the failed generation and starts a fresh provider
attempt. Pi buffers events until an attempt settles, so partial tool calls from
an exhausted model cannot execute. Previously completed tool work remains in the
durable transcript. Usage records retain the actual answering model and the
failed attempts. Subscriber-credit calls have zero incremental charge and retain
the standard API comparison under billing reason `subscriber_credit`.

Ordinary invalid requests, invalid credentials and unknown provider failures
retain their diagnostics instead of authorizing spend on another provider.
The pre-existing ChatGPT OAuth transports remain separate from AI Gateway;
billed Anthropic and OpenAI requests continue through the gateway.

## Background work spends within window budgets

Amended after Claude credit drained at standard cost uncounted and background
relevance and Mail import calls paid Unified Billing while free capacity was
hours away. Interactive work (member-started Runs, member-selected Email
imports and calls outside a background Run) keeps the ladder above. Background
work — a Run whose lineage root has purpose `background` or was scheduled,
discovered or backfilled — follows a narrower ladder. This includes automatic
feature refreshes with the default `ephemeral` trigger, Mail discovery, its
relevance fallback and the Mail import Runs it starts:

1. Claude subscriber credit, while the window's credit budget (standard cost of
   `subscriber_credit` usage, default $1.50 per six-hour window, member-editable)
   has room and Anthropic does not refuse.
2. The ChatGPT plan, while connected, not quota-refused, and the window's plan
   budget (standard cost of `plan` usage, $2) has room.
3. Paid models within the paid budget ($1 per window).
4. Otherwise the Run pauses and resumes when the next window starts.

Amended 2026-10-19: both free sources are capped resources the household
shares with its own use. The Claude credit is a $200 monthly allowance; $5
per window allowed about $600 a month. The ChatGPT plan's quota is shared
with members' own coding, and was uncapped: Mail import alone drew $263 of
standard-cost Sol from it in one day. Background work previously never paid
and waited for a free source instead; with both free sources capped, the
member chose a bounded paid rung over waiting.

Amended after a Console spend limit was re-tried on every request (271 refused
calls in 25 minutes, seconds of latency each): Cubby records a provider credit
refusal until the date Anthropic names, or the window end, and skips the
credit rung until then, probing once per window. A member reset or credit
budget change clears it. The mechanism lives in
[Infrastructure](../infrastructure.md#claude-subscriber-credits).

A member's "Run now, paid allowed" grant, available in the Run header's
More actions menu and on the Mail import card, resumes a paused Run (its
retries and the imports its discovery starts) now. Spending past a spent paid
budget requires a second confirmation naming the amount, valid only for the
window it was granted in. The paid budget counts charged cost only, so credit
and plan usage never consume it.
The header exposes this funding action for discovery and suggestion Runs too,
without giving them import-agent commands. Every frontier admission path reads
the same Run grant and window-scoped allowance.

Considered: pausing interactive work too (rejected: rare interactive work stays
interactive); a scheduled six-hour cron for resume (rejected: frequent crons
must not wake Neon; the egress Durable Object holds one alarm instead).
