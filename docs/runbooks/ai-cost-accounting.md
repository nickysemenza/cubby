# AI cost accounting

[Terminology](../guide/terminology.md#domain-language) defines AI standard and
charged costs. These are usage telemetry, not additional Expense ledger rows.
Subscription fees remain separate; paid-call reservations remain conservative
allowance consumption rather than measured spend.

Every call retains independent nullable `standardCost` and `chargedCost`, plus
`costEvidence` identifying price provenance and the billing adjustment. Pricing
captures the selected model's rates, context tier, token classes, and capture
time before a plan or response-cache hit zeroes its charge. A caller can supply
an explicit charge or discounted rates; provider identity alone never implies
a discount. Explicit charge adjustments take precedence; provider-reported
charges then take precedence over discounted-rate estimates, which override
nominal SDK estimates. Published prompt-cache rates are part of the standard
comparison.
Standard comparisons prefer the captured models.dev registry on every AI path.
An unavailable registry may retain a caller or SDK comparison with its explicit
pricing source. Provider-reported amounts remain distinguishable from
usage-based estimates.

Application replays have zero incremental charge and an unknown comparison
unless equivalent inference evidence was retained. A device executor establishes
zero incremental charge for local image work; lack of usage rows alone does not
establish that work was free. Image jobs without an executor or usage retain
incomplete price coverage, including while waiting for Apple. Unknown prices remain unknown.

Summaries retain independent known subtotals and unpriced-call counts. Savings
sum standard minus charged only where both are known, with comparison coverage
shown separately. Sources without a complete call roster retain explicit cost
coverage flags rather than inventing calls. The external cookbook extractor
currently reports a single cost estimate: fresh reports identify it as a caller
estimate, retained legacy reports as historical, and their standard comparison
remains unknown without equivalent pricing evidence. A linked image job is a component of its parent Run's cost;
displaying both does not create additional spend. Run totals include every
transitive descendant Run and linked image-processing attempt, including failed
attempts. Each usage row contributes once even if both lineage and a job link
reach it; never sum inclusive child totals into their parent. Pagination limits
only the displayed call list, not the subtotal. Missing usage on any attempt or
an external processor makes coverage incomplete; device-completed work proves
zero charge but does not invent a standard-cost comparison. Reads never call a
model or count budget reservations as spend.

Current queued messages retain their captured prices through retries. Raw legacy
in-flight messages without captured costs receive one compatibility upgrade at
consumption: supported inference usage captures current rates and labels the
recovered comparison and missing charge as reconstructed estimates. Every
numeric legacy charge is preserved. Caller-cache metadata alone never proves a
free gateway call; unsupported usage remains unknown. Catalog outages retry the
legacy batch rather than permanently marking reconstruction unavailable.

Reads use stored prices and never reprice history from a changing catalog.
Historical charges and tokens survive migration; original single-cost values
are retained in evidence. Historical standard comparisons reconstructed using
current rates carry that provenance and their captured rate snapshot. Unsupported
comparisons remain unknown with a separate reconstruction-attempt marker, and
repeated reconstruction does not change them.

Money uses the shared Rust formatter on web and Apple. A nonzero amount below
display precision uses a signed threshold (`<$0.01`, `-<$0.01`) instead of zero.
AI presentation uses four to six decimal places with a threshold for smaller
amounts. Only exact zero is displayed as zero. Rounded currency cells and AI
costs expose the full stored decimal amount on hover or keyboard focus. Table
hover uses the shared full-value spill, while AI tooltips retain comparison
coverage and price provenance.

## Expand/contract rollout

Follow [production migrations](production-migrations.md) with one exclusive
migration owner. Apply through `0051_ai_cost_accounting_expand`, verify all
retained rows, original charges, and unrelated household data, then deploy the
matching code. While old writers remain deployed, new rows can still have null
`costEvidence`: verify preserved expanded rows separately and count these late
arrivals, rather than treating live-table fingerprint changes as data loss.
Retain per-table aggregate fingerprints and compare unrelated household tables.
After old in-flight writers settle, apply through
`0054_ai_cost_accounting_contract`; it locks the legacy source while preserving late rows and removing the old
column. Read back the catalog and preserved evidence.

After the matching deployment and contract migration, preview the historical
comparison reconstruction, apply it, then repeat to verify zero new candidates:

```sh
pnpm --filter @cubby/web db:backfill-ai-costs --target=production
pnpm --filter @cubby/web db:backfill-ai-costs --target=production --apply
pnpm --filter @cubby/web db:backfill-ai-costs --target=production --apply
```

The command requires the explicit direct production URL, captures one catalog
per invocation, and reports aggregate counts only. Preview rolls back; applying
changes only historical comparison prices and their evidence, never recorded
charges. Writes are batched to avoid a database round trip per historical row;
preview, atomic rollback, and replay guards are the same. A catalog outage refuses the reconstruction.
