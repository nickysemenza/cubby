# ADR 0010: Unattended Mail import, interactive Burn-down

Status: Accepted.

The maintained [shared work model](../guide/work-queue.md#choose-the-executor)
owns executor routing; [Burn-down](../guide/burn-down.md) owns the interactive
workflow. Pi and Burn-down use the same public MCP tools; the private
research tool family, its independent assessor, the signed Mac browser bridge,
account sync, charge hunts and unattended Product enrichment are deleted, along
with their historical execution tables.

We chose this over continuous unattended enrichment because driving the member's
browser from the server required a relay, a native command executor, pause and
permission states, a second write contract and attention UI that together
outweighed the research they enabled, while Claude and Codex already own a
browser and semantic judgment. The consequence is deliberate: with no caller,
Products keep their gaps and the Research queue grows until the next Burn-down.
Server-side public research is a separate proposal
([#2129](https://github.com/nickysemenza/cubby/issues/2129)); it does not change
the current routing of vendor website/logo research to Claude/Codex sessions.

The dedicated Work queue combines interactive Research, Email attention,
findings, reconciliation and account review from their existing predicates.
Problems and Research views link to it. The household table shows filterable
Waiting for routing: current members, Either for shared work, or unresolved
private ownership. `activity.work_queue` offers only the authenticated member's
eligible work plus shared work, before counts and pagination. Routing follows
current source/account authority rather than inventory ownership or historical
actor snapshots; private originals keep their existing access checks. Queue
reads create no records, launch no inference and authorize no execution.
Automatic maintenance recovers missed queue publications on app open and daily.
Related retained Emails from enabled connected mailboxes enter import automatically,
including unclaimed Email classified before automatic admission was introduced.
MCP mutations allowed by a Run's capabilities execute without per-operation
approval or approval bindings. Stable operation IDs, exact-input replay checks,
member/source ownership, transaction fences and audit receipts remain enforced.
Historical approval-paused Runs resume through the normal dispatch path; existing
approval history remains stored. Photo group review and ambiguous business
choices keep their domain review flows.
