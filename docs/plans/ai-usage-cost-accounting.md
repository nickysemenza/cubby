# AI usage cost accounting

Status: approved design and implementation brief. Subsequent commits record
the executable change and its validation; durable behavior moves to its owner.

## Confirmed requirements

- A nonzero money amount must never display as zero because of rounding.
- AI usage must retain both its price without a plan or discount and its
  incremental charged price, including zero when a plan covers the call.
- The accounting and presentation contract applies generically across AI
  providers and execution paths, including future discounts.

## Current implementation evidence

- `packages/shared/src/ai/pricing.ts` estimates usage from model rates and
  reported token classes.
- `apps/web/src/server/ai/usage.ts` stores one `estimatedCost`; plan usage and
  response-cache hits overwrite that cost with zero. The undiscounted amount
  is not retained separately.
- `apps/web/src/features/ai/ai-usage-page.tsx` already displays additional
  fractional precision. `apps/web/src/app/runs/run-history.tsx` uses ordinary
  cent precision, which can display positive amounts as zero.
- `apps/web/src/lib/number-format.ts` already has `formatSmallCurrency`, which
  displays a positive sub-cent amount as `<$0.01`.
- `packages/shared/src/ai/pi-providers.ts` also replaces the SDK cost breakdown
  with zero for plan-covered responses and gateway response-cache hits. Both
  normalization points must retain the comparison price.
- `apps/web/src/server/repo/ai-usage.ts` can estimate missing historical costs
  from retained token counts using the current catalog. Runs aggregate stored
  costs instead, so the views can disagree about missing prices.
- Native activity and cookbook entity reports also use cent precision;
  cookbook import panels already use the sub-cent threshold formatter.

## Accepted first-round decisions

1. Retain independent standard and charged costs with evidence distinguishing
   estimates from provider-reported amounts. Plan coverage establishes zero
   incremental charge; subscription fees remain separate.
2. Standard cost uses published rates for actual token classes, including
   prompt-cache rates. A response-cache hit retains an equivalent inference
   estimate only when supported by evidence. On-device work has zero
   incremental charge and no standard API comparison by default.
3. Preserve historical recorded charges. Reconstructed comparisons using
   today's catalog are explicitly current-rate estimates; absent evidence
   stays unknown.
4. Shared money formatting preserves the sign and nonzero nature of small
   amounts, using thresholds where displayed precision is insufficient. AI
   surfaces show charged cost first, standard cost alongside, and the reason
   for any billing adjustment.

## Accepted second-round decisions

5. Aggregate known standard and charged subtotals independently and report
   unpriced-call counts for each. Savings use only calls with both amounts
   known and disclose incomplete comparison coverage. Parent Runs and their
   image jobs must not be counted twice.
6. Preserve current conservative paid-call reservations and allowance behavior.
   Plan-covered calls continue bypassing paid admission; cost reporting does
   not increase spending allowance.
7. Support generic billing reasons, pricing evidence, and applied adjustments
   now, including caller-supplied discounted rates or charged amounts. Add
   provider-specific discount configuration when a real discount exists.
8. Reconstruct historical comparison prices once using a captured current-rate
   snapshot, label them reconstructed, and preserve original evidence. Leave
   unsupported amounts unknown. New calls retain pricing evidence at recording
   time so their costs do not drift with catalog changes.

## Implementation brief

The main agent owns integration, migrations, and final validation.

1. Replace the single-cost contract with a shared standard/charged accounting
   contract, including nullable amounts, pricing provenance, and adjustment
   evidence. Derive HTTP, MCP, and native shapes from shared schemas.
2. Carry the contract through adapters, telemetry, storage, cookbook usage, and
   reporting. Preserve comparison prices before any billing normalization.
   Move every caller and remove the old single-cost shape.
3. Migrate existing records without discarding original amounts or token
   evidence. Capture rates for a bounded, repeatable historical reconstruction;
   do not reprice history when rendering it. Follow the production migration
   ownership and data-survival requirements before deployment.
4. Use shared aggregation and cost presentation for AI usage, Runs, image jobs,
   cookbook reports, and native activity. Apply the no-rounded-zero rule to
   shared money formatting across clients, preserving negative signs too.
5. Update owning behavior documentation with the implemented contracts. Remove
   this completed plan after durable facts move to their owners.

## Failure modes and validation scope

- Tiny positive or negative amounts appear as zero in any client.
- Plan coverage or a cache hit discards the standard comparison price.
- Discounts are inferred from provider identity without billing evidence.
- Unknown amounts become zero, or partial totals imply complete coverage.
- Savings compare different call populations or count linked jobs twice.
- Historical comparison prices change when the live catalog changes.
- A migration overwrites old evidence, repeats a backfill, or loses records.
- Old/new telemetry and native clients disagree during contract rollout.

Choose the narrowest retained runtime checks for these failures before
implementation, following `docs/agents/validation.md`. Verify shared money
formatting and pricing/accounting, PostgreSQL migration and rollups, generated
contract drift, and affected web/native presentation. No runtime checks have
run during the design interview.
