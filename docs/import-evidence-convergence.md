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

Retailer preparation can explicitly target an orderless Purchase. Receipt
itemization proposes a replacement finding with original lines, proposed
identities, and exact beneficiary/funder amounts. Approval binds the full
proposal and original graph; changed proposals or edited originals fail.
Photo groups remain editable and require approval before Product and inventory
writes. Imported source claims alone do not establish reviewed itemization.

## Validation boundaries

`import-order-convergence.integration.test.ts` exercises all 24 arrival
orders of Gmail, retailer, photo, and CSV evidence against PostgreSQL through
the same writers the routes dispatch: real normalization, persistence,
retailer preparation/commit, photo staging/finalization/review, CSV intake,
booking, finding resolution, and order-mail linking.
`import-order-convergence.spec.ts` runs four of those orders in the browser —
cyclic shifts, so each source arrives in every position and every ordered
pair occurs — adding signed photo upload, photo review approval, CSV browser
intake, the Problems fix, and the vendor Link. Only external
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
exercised boundary independently. A successful build or HTTPS retailer
preflight does not establish native intake, capture, photo approval, or CSV
save. Locked-host or authentication failures must remain failed milestones.
Live Gmail authorization, live retailer changes, and physical iPhone photo
quality remain distinct from deterministic import convergence.

## Migration and rollout

The migration adds nullable references and conservative defaults. Existing
Vendor order-evidence policies are backfilled only when the new override is
unset. Existing Products retain unknown acquisition origin. Neither old bank
transactions nor old Expenses are automatically reclassified or booked.
The PR requires production migration and schema readback before merge under
[validation policy](agents/validation.md); deployment does not apply migrations.
