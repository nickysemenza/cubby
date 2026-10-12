# ADR 0013: Stock tracking inherits from Product Category

Status: Accepted

## Context

Whether a Product belongs on a shelf was a per-Product decision only
(`stockTracked`, null meaning undecided), and the "Not on a shelf" view relied
on it deliberately: a product left the worklist by an explicit decision, never
by guessing durability from its category. Purchase import ignored the decision
entirely and asked a member to receive every arrived order with a Product line,
so groceries, pet food and toiletries the household never shelves raised the
same receive prompt as a new tool.

## Decision

A Product Category carries a stock-tracking default that descendants inherit,
the same way `feature` and the spending mapping do. A Product's own decision
wins; with none, the nearest category decision applies; with neither, the
Product is undecided. An arrived order asks to be received only when one of its
lines is effectively stock-tracked, and "Not on a shelf" filters on the
effective value.

A category default is a member's explicit decision made once for a kind of
thing, not an inference, so it satisfies the view's convergence-by-decision
rule. What the view guarded against was category standing in for _durability_;
stock tracking is asked directly instead. Consumable versus durable
(`Product.kind`) remains a descriptive fact and never decides stock tracking:
tool consumables are consumable and tracked, groceries are consumable and
untracked.

## Consequences

An untracked category can hide a durable member (a vacuum filed under
cleaning supplies). Categories whose members differ in stock tracking are
split so each node has one answer, with per-Product overrides for the
remainder. Backstock of an untracked Product is still recorded by hand; stock
tracking governs prompts and worklists, never whether Inventory may exist.
