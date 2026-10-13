# Purchase, photo, and statement evidence

Bank transactions are evidence; Expenses are the spending ledger. Importing a
CSV never creates spending implicitly. The reviewed booking operation either
links recorded Expenses or creates an aggregate allocation line. Purchases
created from bank evidence have no invented order identifier or printed total.

SpendingCategory is independent of ProductCategory. Purchase defaults flow to
Expense lines unless a line has its own category. Receipt expectation resolves
from transaction/Purchase overrides, Vendor, then spending category. A required
receipt, reviewed itemization, Product resolution, and Expense booking have
separate coverage. Optional paperwork contributes no missing-evidence penalty.
Gift and previously-owned Product provenance needs no purchase proof.

Category policies apply to the assigned category, without inheriting a parent
policy. An explicit `unknown` Purchase or transaction override also stops
fallback. Reviewed reimbursement purpose can support the original spending
category; a payment provider name or credit direction alone cannot. Suggestions
use saved linked Purchases, signed Expense lines, and Products, and remain
proposals until reviewed. Native editors request the same backend inference:
policy and create-form choices change the draft; saved finance categories use
the audited atomic Apply command and preserve other unsaved edits.

Vendor paperwork excludes reimbursement Expenses; net spend includes their
signed costs. Booking a vendor refund checks negative principal Expenses and
prior vendor settlements. Discounts cannot be reused as refund evidence.
Partly covered transactions require individual line review rather than
silently recording the full credit twice. Corrections can move an unchanged
aggregate reimbursement to its original Purchase or retire an unchanged
aggregate and attach its bank evidence to a reviewed transfer. Edited,
itemized, or source-claimed lines require individual review.

CSV identity preserves each physical nonzero occurrence, including identical
rows; zero-valued placeholder rows are counted, not saved. Stable provider identifiers are retained; historical
identity aliases remain recognized. A date/amount/status change is a reviewed
candidate attachment, not an automatic merge. Ambiguous same-amount transactions
remain separate candidates. Source rows and their original dates stay intact.

Export coverage records every retained statement identity observed in that
export, independently of which export first inserted its row. Replaying an
overlapping export adds membership evidence without moving original rows,
changing provider values, or creating transactions. Partial exports remain
incomplete; a dry run records no membership. Historical migration seeds only
known first-ingesting memberships; other exports require original-source replay.
Original first ownership remains membership proof through the deployment
window. Drift excludes row pairs known to coexist in any export, even when
another export first retained one. Retired import bookkeeping retains that
coexistence evidence; live coverage still excludes deleted statement rows.
Legacy identities cannot establish distinct
physical occurrences by themselves.

Provider account masks retain all supplied digits, including non-card masks
longer than four digits. An account name already containing that mask does not
receive a second suffix. These descriptors participate in statement identity;
normalization must not truncate them into a different account reference.

Retailer preparation can explicitly target an orderless Purchase. Receipt
itemization proposes a replacement finding with original lines, proposed
identities, and exact beneficiary/funder amounts. Approval binds the full
proposal and original graph; changed proposals or edited originals fail.
Photo groups remain editable and require approval before Product and inventory
writes. Imported source claims alone do not establish reviewed itemization.

Prepared candidate reviews preserve their original evidence. New preparations
record exact name/alias equality explicitly. Historical candidates that never
recorded that judgment expose `exactNameMatch: null`, rather than a fabricated
non-match or a reconstruction from today's catalog. Reading a review does not
rewrite its saved snapshot; commit independently rechecks current identities.
An unchanged accepted item identity replays even when its original resolution
was `new`, when money is incomplete, or after its Product merges. A changed
choice or missing accepted binding requires reconciliation review. Equivalent
second sources retain their observations without duplicating canonical Product
association rows; binding an unbound manual item creates the association once.

A member-reviewed refund reference from an Email is an
`EmailFinancialAssociation`. It retains the exact Email checksum, the original
account label, the reviewed account and decision provenance; it survives
deletion as history, exposes later account drift, and never writes financial
allocations. `mail.resolve` can link a lifecycle Email to several existing
Purchases through `purchaseIds`.

The contracts above are deployed. Remaining live acceptance work belongs in
[the backlog](todos.md#import-pipeline-architecture). Deployment, stored fields
and terminal Runs alone do not establish source-specific acceptance: blocked
bindings still need public writer/readback verification, and missing original
preparations remain evidence gaps. Historical restart readiness requires
authorized scope and transport/coverage evidence; missing evidence stays unknown,
never reconstructed from current defaults. Continuous financial processing needs
acceptance beyond classification-only discovery. Existing-Purchase attachment and
accepted-source reconciliation preserve money and stock and refuse ambiguous or
changed original bindings.

## Validation boundaries

`import-order-convergence.integration.test.ts` exercises all 24 arrival
orders of Gmail, retailer, photo, and CSV evidence against PostgreSQL through
the same writers the routes dispatch: real normalization, persistence,
retailer preparation/commit, photo staging/finalization/review, CSV intake,
booking, finding resolution, and order-mail linking.
`import-order-convergence.spec.ts` retains two browser orders: statement-first
requires reviewed receipt reconciliation; receipt-first links existing
itemization. Both retain signed photo upload, photo review approval, CSV browser
intake, and vendor-to-Purchase-to-Product navigation. The statement-first case
also retains the Problems fix beyond the overview's first twelve findings.
The PostgreSQL matrix owns exhaustive arrival-order coverage. Only external
classifier/image-description output is deterministic. Both assert the final Product, inventory ownership, Expense,
Purchase allocation, and original source edges; neither seeds the economic
graph or repair it at the end.

`pnpm test:e2e:sim -- --headless --statement-csv` drives a real Swift CLI
file through shared OpenAPI preview and reviewed commit. It checks read-only
preview, repeated physical rows, exact replay, changed-byte refusal, ambiguous
settlement-date attachment, and no implicit Expense or Inventory writes. The
CLI is a loopback test harness; native UI acceptance still exercises file
selection, presentation, and approval.

`finance-evidence-journey.spec.ts` covers reviewed spending, reimbursements,
corrections, transfer conversion, and refusal after edits.
`financial-booking-review.spec.ts` drives browser review, stale refusal, exact
retry, and altered retry. SQL boundary regressions cover settlement identity,
receipt-policy precedence, quality exceptions, cent-preserving replacement,
and refund capacity.

The Mac runner is documented in
[mac-import-e2e.md](../apps/web/tooling/mac-import-e2e.md). It builds and signs a
separate app identity, uses fixture account/browser state, and records each
exercised boundary independently. A successful build does not establish
native intake, capture, photo approval, or CSV save. Locked-host or authentication failures must remain failed milestones.
Live Gmail authorization, live retailer changes, and physical iPhone photo
quality remain distinct from deterministic import convergence.

## Migration and rollout

Follow [production change rules](agents/domain-rules.md#production-changes).
Historical backfills must preserve unknown acquisition origin and evidence;
existing bank transactions and Expenses are not automatically reclassified or
booked. Deployment never applies migrations.
