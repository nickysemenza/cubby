# ADR 0017: Subscription-funded model fallback

Status: Superseded by [ADR 0027](0027-tier-routed-models-on-a-funding-first-ladder.md),
which carries its funding sources, windows, refusal holds and accounting
forward. Accepted 2026-10-14.

## Decision

Use the monthly Claude API credits included with an eligible Claude plan as a
second subscription-funded capacity pool beside the ChatGPT plan. A feature
declared an ordered list of chat models, and Cubby advanced to the next only
when the current one's subscription capacity was exhausted, never falling back
to paid API billing. ADR 0027 replaced the per-feature model list with tiers on
a funding-first ladder that can end in paid billing where the caller allows it.

The full text is in git history.
