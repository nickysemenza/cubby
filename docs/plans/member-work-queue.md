# Member-routed Work queue

Status: implemented and independently reviewed. Local acceptance passed four
real-MCP tests, two fingerprinted Worker browser flows, the generic pager
regression, strict declaration loading and web/test types. Deployment and live
household-scale acceptance remain separate. The initial MCP boundary regression
failed before the action existed.

Add one dedicated Work queue page, linked from Problems and the Research saved
views. Use the existing RTable and visual language. Its filterable **Waiting for**
column derives current household members from evidence/account ownership or
shows **Either** for shared work. Unresolved routing remains explicit.

One shared derived projection supplies UI and MCP; no new task ledger or copy of
the private audit file. Reuse canonical Research/attention views and Problems
predicates for research, import findings, financial review and account work.
Preserve their source records, evidence and existing review/writer paths.
Record rows open their existing detail view; aggregate diagnostics without a
public record open Problems. Public derived diagnostics use count-only summary
rows rather than loading every affected record on each queue page. Private
financial groups preserve all required source-owner checks together.
Run rows temporarily open Problems because the existing live Run detail stream
can initialize execution while observing it. Safe retained status/transcript
reads remain available through MCP; the separate Run-view correction is tracked
in `docs/todos.md`. Opening the queue must not resume paused work.

Automatic embedding work, stale-derived recomputation, provider UPC probes and
referential-liveness engineering maintenance remain in their owning Problems
controls. They do not represent work awaiting a member's interactive session.

The household UI can inspect routing metadata and filter by member. MCP's
actionable read always uses its authenticated member plus shared work, applying
eligibility before pagination and counts. Caller filters cannot widen this
scope. Private originals retain their existing owner fences.

Route by what the work requires: public Product facts can be shared; private
Email, account history and source-backed reconciliation follow current source
ownership. Inventory ownership, expense attribution and historical actor
snapshots alone do not establish private account access. Unknown ownership is
not permission to offer another member's source work.
Paperwork, itemization and receipt-image research require source authority;
payment ownership alone does not establish access to those originals. Financial
reconciliation also checks the settlement accounts required by that work.
Product-relink proposals must identify the finding's actual Expense before
using source-only routing; stale or mismatched targets remain unresolved.

Acceptance requires both member connections, shared research, account/source
ownership fallbacks, unresolved ownership and paged/filter counts at the service
boundary, plus the RTable's owner filter and record navigation in a synthetic
browser flow. Preserve money, stock, claims and provenance; queue reads launch
no inference, import or approval. CI and installed-client acceptance remain
outside the member-directed scope.
