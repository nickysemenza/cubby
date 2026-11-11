# ADR 0027: Tier-routed models on a funding-first ladder

Status: Accepted. Supersedes [ADR 0017](0017-subscription-funded-model-fallback.md).

## Context

ADR 0017 and its amendments fixed one model per funding rung: Opus on Claude
credit, then Sol on OpenAI credit, the ChatGPT plan and paid. A feature's tier
selected only the provider entry, so every web feature — fast tier included —
was answered by Opus or Sol, and Luna answered only the Mail coordinator. Window
budgets count standard API cost, so the costliest model drained each free
window fastest. Over three days in November 2026 the Mail coordinator's Sol
escalations were 88% of its standard cost, while the Claude credit, refused for
the rest of its cycle, was still attempted and recorded as thousands of failed
usage rows.

## Decision

A chat call names a **tier** — what it needs from a model, not which model:

| Tier       | Meaning                                   | OpenAI routes   | Claude credit       |
| ---------- | ----------------------------------------- | --------------- | ------------------- |
| `fast`     | Interactive and bulk calls                | `gpt-6-luna`    | `claude-haiku-5-5`  |
| `standard` | Evidence that writes money                | `gpt-6.1-terra` | `claude-sonnet-5-5` |
| `quality`  | Calls whose accuracy outweighs their cost | `gpt-6.1-sol`   | `claude-sonnet-5-5` |

`CHAT_TIER_MODELS` in `packages/shared/src/ai/models.ts` is the only table.
Callers keep naming a tier by its OpenAI model (feature records, agent manifests,
cache keys), and the ladder substitutes each route's model, so changing a tier's
model is one edit. Anthropic has no model priced like Terra; Sonnet serves both
upper tiers on Claude credit. Opus leaves routing.

The **funding ladder** is source-first, model-second (`fundedChatAttempts`):

1. Claude subscriber credit, with the tier's Anthropic model.
2. OpenAI API credits, with the tier's OpenAI model.
3. The ChatGPT plan, with the tier's OpenAI model.
4. Paid Unified Billing, with the tier's OpenAI model, where the caller allows it.

A step advances only on a funding refusal. A paid fallback therefore buys the
tier's model — Terra or Luna where that is the tier — never Sol by default.
Both provider credits are free and renew monthly, so the order between them
only decides which lapses unspent; Claude credit stays first. When no source
can fund a call, background work pauses and interactive work fails with the
provider's raw diagnostics, as before. Tiers are chosen by judgment and move
when production evidence — audit findings, corrections, member reports —
shows a problem; there is no evaluation gate.

**A feature's tier is its ceiling.** Standard cost per answer, not per call,
decides what work costs, and most answers need only the fast tier. A structured
feature answers on `fast` first; each stronger tier up to the declared one
answers once, only after an answer without the forced tool call, a
schema-invalid answer or one its caller's validation rejects. A transport or
funding failure surfaces as before. Purchase audit runs on `fast` at high
effort and has no second-model recovery.

**Escalation is one question.** The Mail import coordinator stays on Luna
(#2151) for the whole Email. Its escalation request names one question; the
host asks `standard`, then `quality`, once each per Email, with the compact
Email and the coordinator's stated facts, outside the conversation, and returns
the answer. Switching the conversation's model re-wrote the cached prefix
under the stronger model and priced every later step at its rate; over two days
in November 2026, Terra escalations were two to four times Luna's daily
standard cost. A transient-failure retry runs on the primary. Photo inventory
runs on `quality`; it has no escalation.

**Unattended OpenAI calls use flex.** Work no member waits on (coordinators and
automatic feature calls) asks OpenAI for the `flex` service tier on credit and
paid gateway routes, and resends at the standard tier when OpenAI refuses for
flex capacity. Flex publishes half of every standard rate, so its usage rows
record flex rates as their standard cost. OpenAI credit through the native
route serves flex; the paid Unified Billing `/ai/v1` route answers at the
default tier, which its rows record. The ChatGPT plan and Claude credit are
unaffected.

## Carried forward from ADR 0017

- **Funding sources.** The Claude subscriber key is the gateway's
  `subscriber-credit` BYOK alias with `cf-aig-no-wholesale: true`; OpenAI credit
  and the ChatGPT plan follow; one gateway, `cubby`, serves every environment
  with environment metadata for attribution.
- **Background windows, narrowed.** A Run whose lineage root is background,
  scheduled, discovered or backfilled — and any call without a Run that declares
  no waiting member — draws the ChatGPT plan only within its six-hour window
  budget (standard cost; the plan's quota is shared with the members' own use),
  then the paid budget, then pauses until the next window. A member's "Run now,
  paid allowed" grant resumes it within the granting window. Budgets count chat
  and cookbook frontier models.
- **Refusal holds.** The `AI_GATEWAY_EGRESS` Durable Object records a provider
  credit refusal until the date the provider names or the window end, answers
  credit admission locally while it holds, and probes once per window. It is
  the only owner of holds, and a streamed response settles its hold when the
  stream ends: a terminal funding refusal records it, a clean end clears it.
  One shared classifier (`classifyFundingRefusal`) names every funding
  refusal, HTTP or terminal, by source and kind. A refusal Cubby answers
  itself (`cubby_credit_refused`, `cubby_plan_budget_reached`) made no
  provider call and is not recorded as a usage row.
- **Two waits.** When no source can fund background work it waits for funding
  (`ai_funding_window`) until the window end plus 60 seconds, including a
  missing paid BYOK credential; a provider configuration stop waits 15 minutes
  as `provider_capacity`. One funding wake brings every funding wait forward
  at a window boundary, a member reset, or a raised budget.
- **Embeddings.** Embeddings use OpenAI credit first, then paid Unified Billing
  (`/ai/run` with the model's catalog id) with no window budget: they are
  cheap, and semantic work never waits while paid can answer. A member's
  search fails with a readable error when both refuse; background embeddings
  wait for funding.

## Credits have no window budget

ADR 0017 capped each provider credit per six-hour window so background work
could not drain a monthly allowance early. Running out early costs nothing:
the credit renews each cycle, and an unspent window only left credit unused
while work waited. Claude and OpenAI API credits therefore run until their
provider refuses; the egress object holds that refusal and the ladder moves on.
The plan keeps its window budget because members' own coding shares its quota,
and paid keeps its budget because it is real money. Stored credit limits are
dropped when the settings row is read and rewritten.

- **Accounting.** Credit usage records `chargedCost = 0` with its standard
  comparison cost under billing reason `subscriber_credit`; usage rows name the
  model that answered.
- **Fixed models.** Fixed-model evaluations bypass the ladder, and explicit
  coordinator overrides (`coordinatorModels`) are pinned: they ladder only
  over their own route's funding sources, never through tier substitution, so
  comparisons measure the requested model.
- **Execution fences.** A workflow's ownership check runs before every credit,
  plan and paid transmission (`beforeCreditRequest`, `beforePlanRequest`,
  `beforePaidRequest`), although credits carry no budget.

## Consequences

- Fast-tier calls on Claude credit run on Haiku, priced like Luna below 100k
  prompt tokens and fivefold above; it tokenizes the coordinator's tools to
  about twice Luna's count.
- A structured feature whose fast answer is usable never spends its declared
  tier; one whose answers are invalid spends every tier once.
- Flex answers may be slower or refused for capacity; the standard-tier resend
  keeps the answer, at the standard price.
- Durable coordinator state written before this change may name a retired model;
  `storedChatModelSchema` reads it as absent and the Run resumes on its
  manifest's model.
- Usage of retired model ids (`claude-opus-5-5`, `gpt-6-sol`) drops out of the
  window that contains the cutover, so that window's plan and paid budgets
  under-count once.
- Once both credits are spent for the cycle, background work reaches the plan
  and paid budgets sooner than under per-window credit caps.
- Feature calls keep provider-specific stream options; pi-ai's neutral
  `toolChoice` cannot force a named tool, which OpenAI structured calls need.

## Considered options

- **Cloudflare AI Gateway Auto Router** (`cloudflare/auto`): rejected. It ranks
  by list price, cannot see subscription capacity, includes Unified-Billing-only
  models, varies per request, and supports only Chat Completions and Responses.
- **An evaluation gate per tier change**: rejected as ceremony at household
  scale; production signals and the optional Mail replay suffice.
- **Retrying a failed audit on another model**: rejected with the paid Opus path.
- **Pre-reading funding state to skip refused sources**: rejected; the egress
  Durable Object already answers them without an upstream call.
