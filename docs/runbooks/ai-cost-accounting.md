# AI cost accounting

[Terminology](../guide/terminology.md#domain-language) defines AI standard and
charged costs. These are usage telemetry, not additional Expense ledger rows.
Subscriber-credit inference records billing reason `subscriber_credit`, zero
incremental charge and the standard API comparison; its nominal comparison
tracks credit consumption separately from paid inference.
Subscription fees remain separate. The household AI budgets
(`server/ai/budget.ts`) read frontier chat-model rows per fixed six-hour UTC
window: the Claude credit budget (default $1.50) sums the standard cost of
`subscriber_credit` rows; the ChatGPT plan budget (default $2) sums the standard
cost of `plan` rows; and the paid budget (default $1) sums every other row’s
charged cost, falling back to the standard cost. Credit rows never count as
paid. All three limits are editable inline in Settings → AI funding, or through
`ai_funding.set_credit_budget` with `creditLimitUsd`, `planLimitUsd`, and
`paidLimitUsd`. These are soft limits read from the asynchronously written ledger.

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
unless equivalent inference evidence was retained. A response-cache entry
retains the token usage of every call that produced its answer (a batched
decision question keeps its even share of the shared call); a hit prices that
avoided usage at the current catalog rate when it is recorded and keeps it in
`costEvidence.avoidedUsage`, while the hit's own token columns stay zero.
Entries published before usage retention, and caller caches without token
evidence, keep the comparison unknown. A device executor establishes
zero incremental charge for local image work; lack of usage rows alone does not
establish that work was free. Image jobs without an executor or usage retain
incomplete price coverage, including while waiting for Apple. Unknown prices remain unknown.

The application response cache (`server/ai/response-cache.ts`) keys an answer
by feature, prompt version, requested model, the input and options that shape
the provider request, and a structured call's output schema. Media in our R2
bucket is keyed by URL, since its object keys are unique per write; other URLs
are fetched once, sent inline and keyed by content digest. A funded call is
keyed by its requested tier model, and its entry keeps the model that answered,
which a hit reports and books. Embeddings are cached per distinct text and
dimension count; only the misses reach the provider, in one request. The runner
waits for every text to finish and cache its answer before deferring a batch
with a busy key; a sibling provider failure remains attached as the cause.
Completed answers never expire: rows written under the retired 30-day expiry
and bare entries from before usage retention stay readable without relabeling
their usage. Values larger than one SQLite row are stored across chunk rows,
up to a 16 MB bound below the Durable Object RPC message limit; a larger answer
fails rather than bypassing the cache. Identical concurrent calls share one
claim. An explicit regeneration (`force`) bypasses the matching entry and
replaces it only when the new answer is written; failed or invalid answers are
never stored, and a failed regeneration keeps the prior answer. A cache
outage, an unwritten answer or an interactive wait past five minutes never
places an uncached call: it throws `JobDeferredError` with the raw cause, which
a job republishes as a deferred page and an interactive caller surfaces. A job
page defers on its first contended lookup instead of polling.

A new answer is written before the call reports success. When the write still
fails after its retries, the call defers with the cause, keeps the
answer in its Worker isolate, and lets its claim expire instead of releasing
it; a retry in that isolate writes the kept answer without another provider
call. Kept answers are bounded (512 entries, about 32 MB, oldest dropped
first) and dropped once written or replaced by a cached answer. The cache
cannot remove a duplicate charge when the provider billed an answer that was
never durably written and the retry runs in another isolate, after a restart,
or after its kept answer was dropped: it computes the answer again. The
purchase-import audit recovery call shares this cache under its own model,
options and output schema. Injected test ports and live evaluation harnesses
that set `cache: false` bypass it.

Summaries retain independent known subtotals and unpriced-call counts. A failed
call that reported no usage had nothing to price: it is counted as failed
without usage, not as unpriced. Savings sum standard minus charged only where
both are known, with comparison coverage shown separately; the household usage
summary also splits them by billing reason (plan, subscriber credit, cache,
discount). Sources without a complete call roster retain explicit cost
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

Run usage membership is an indexed union of directly attributed calls, linked
image-job calls, and linked image-attempt calls. Resolve that set before reading
the subtotal and page; a correlated job-membership check for each unrelated
usage row makes household-wide history consume Run-detail query capacity.
Resolve the transitive Run scope once per read and share its bound UUID set
across membership, totals, pagination, and completeness checks. Recursive scope
estimates inside each usage query can otherwise make selective Run reads scan
unrelated history. An empty live scope matches no calls.

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

Accounting integration fixtures supply the shared egress binding for decision
calls, including Jev BYOK. They keep real database accounting and stub the
routed inference boundary; the Worker egress suite owns credential routing.
Ordinary decisions retain exactly one usage row, while Gateway cache hits keep
provider token usage and record zero incremental charge.
