# One view of the work

The Work queue derives work from records, gaps, findings, execution, review
state and Problems detectors. Each domain declares its Work sources (reasons,
Work family, Executor, link, actions and a candidate query); the queue composes
them explicitly and owns filtering, search, sorting, Group by, saved views,
counts and paging. Its All, Automatic, Agent, Review, Waiting and Problems views
share that one server read with record work sections, including Runs. GitHub
Issues owns delivery and remaining domain coverage.

Statement review work probes current eligibility only for the admitted financial
accounts, stopping after the first eligible proposal per account. Record work
for another entity never prepares statement suggestions. These reads retain
source withdrawals, ignores, supersessions and settlement references as the
eligibility authority; a stored pending proposal alone does not establish work.

The Runs header links to **Run types** (`/runs/types`), a catalog of every
declared Run kind. Its indexed sections expose purpose keys, execution owners,
progress sources, AI ownership and ordered steps (purpose, action, input mode,
units and suggestion families) directly from `RUN_KINDS`. Metadata and recent
activity use the shared `Facts` list and canonical Run entity links; ordered
steps use columnar `RecordList` rows, with shared technical headers on wide
surfaces and labeled inline facts on narrow ones, matching `/design`.
Types marked historical
appear under “No longer created”; their retained history remains accessible.
Types without fixed steps say so rather than inventing a sequence.
Each type links to its filtered Runs history, including routine and ephemeral
work hidden from the default list. A shared household-wide activity read shows
the latest run by start time and latest completed run by finish time for each
purpose, excluding deleted rows. Activity refresh is explicit, and errors leave
the static reference usable. Completion is a stored status, not a claim that
every target succeeded. Scheduling cadence and start controls remain in their
existing owners; the catalog does not infer them from the trigger category.

## Review a Run

Run detail leads with its purpose, recorded outcomes and actionable work. Photo
review, purchase findings, prepared orders and Assessment review keep their own
domain tools within the same record workspace. Items and outcomes is an inline
searchable table: a row opens evidence beside the list (a sheet on phones),
while its record name opens the source record. Input-target status, published
recommendations and actual record changes remain separate facts.

Review tables start at Needs attention when supported decisions exist, otherwise
Results. Results includes processing, skipped, blocked and completed items;
completion never implies every item succeeded. The live phase summary keeps Run
status current. Execution steps, diagnostics, transcripts and usage follow the
work and start folded. Section links open the
corresponding evidence without replacing the workspace.

Live updates refresh existing values without reordering admitted rows or closing
the inspector. New items wait behind Show new items. A resolved item stays in the
current attention view until the member refreshes that view. Filters and explicit
selection define batch scope: selected rows take precedence; otherwise only ready
items matching the current view apply. The impact summary precedes the write.
Unsupported or stale decisions cannot become writes just by opening the inspector;
review actions come from the shared domain queue and retain its fingerprints.

Completed Runs retain evidence, changes, supported corrections and existing retry
controls. A retry keeps its execution lineage rather than rewriting the original
Run's history. Table views and selection are session state, not another stored
work ledger.

## Shared work, different ways to complete it

The Work queue, a record's work section, and a Run's progress should explain
the same work from different starting points. Automatic work, interactive
research, review and waiting are views over that work. A change of executor
does not create another copy of the underlying problem.

Keep durable evidence, decisions and execution in their existing owners:
entity declarations and data-quality checks describe missing facts; findings
and Assessments retain unresolved decisions; Runs record execution; domain
commands own writes. Add a Work source in the owning domain rather than
introducing another task ledger, workflow engine, or entity-specific queue
state. Queue reads explain current work without launching inference or
mutations.
Counts cover known candidates while Project attention inputs are unavailable.
The queue reports those incomplete Projects from the same request-local
attention read, and displays that limitation beside its results.

Pending reviewable suggestions produce one row per live record, combining their
family reason keys and opening that record's Suggestions. Statement proposals
belong to their financial account. There are no family-only suggestion rows.
Home's Needs you preview excludes the pending-suggestion family and links to
the same scoped queue, avoiding the population-wide statement eligibility read
on every Home visit. Suggestions remain available in the full Work queue,
Suggestions, and record work sections. Unrelated record reads skip statement
evidence entirely; account reads scope evidence before materialization.
Purchase amounts are the sum of live Expense costs, including credits; other
records carry their own amount and calendar date. Planned purchases are deferred
across every family before counting or paging.

The queue is a [Declared list](terminology.md) over its sources' union, so its
filters behave as entity list filters do: Type, Owner, Family, Executor and
Reason each accept their `Exclude` input, Type and Owner accept No value, and
Owner accepts Me. The Reason filter selects stable `reasonKeys`: data-check
keys, Problem keys and source keys such as `reconciliation:purchase-unsettled`.
A reason filter prunes sources that cannot emit any selected reason before the
union, and search matches a row's name, reason and shortcode. Totals, view
counts and group counts are computed in the same pass and describe all matching
work; only the page's rows receive quality gaps and thumbnails.

Owners follow the authority a source needs, never inventory ownership. Shared
work lists every member, so filtering by a member (including Me) includes it;
Unresolved is the Owner filter's No value. An agent's MCP read sees shared work
and work owned only by its own member.
Sources whose resolved authority can name only one current member may declare
that necessary owner to narrow admission before routing. Full current authority
checks still decide access and counts. Owner presence widens selected owners,
so mixed presence/inclusion requests retain the full population; joint-authority
sources do not declare a sole-owner hint.

A row states its Reason, Executor, Owner and the source's declared actions.
Executor is who acts — Cubby automatically, an agent session, a member, or
something outside the household — and is separate from Owner: an automatic
step can still wait on a member's evidence, and Waiting covers posting windows,
the AI budget and paused Runs.

A reconciliation investigation is actionable member work even when the
automatic writer lacks evidence. Running status alone does not establish
automatic execution: the Run source requires a Workflow-backed purpose or a
retained dispatch event. Unscheduled interactive Runs keep their domain handoff
instead of appearing as automatic work; authorized Vendor-history prerequisite
waits remain visible.

## Problems and declared actions

Problems is the queue's saved view of the `problem` Work family. Each Problems
declaration is a Work source: record-grain detectors contribute one row per
record, and derived diagnostics contribute one row per count that filters the
queue to its reason group. A source declares its remediations as actions: an
item action on each row, and a group action on its reason group's header
(Group by Reason) that re-reads the source's own query rather than trusting
loaded rows. Guided flows open their domain's dialog; the web client's
`workActions` feature table performs each declared action, typed from the
declarations so a missing or renamed handler fails to compile. Maintenance
tools that are not a Problem's remediation live in Settings → Maintenance.

## Choose the executor

Cubby owns deterministic retrieval, replay, validation and derived state. Pi
interprets available import evidence and coordinates supported unattended
work. Jev/Clef make bounded semantic decisions and rank uncertain candidates;
the domain writer independently checks whether a proposed change can apply.

Expenses missing their effective spending category enter Research alongside
unresolved Product identity. Supported financial spending can be booked as an
Uncategorized aggregate while categorization remains in Work.

Claude/Codex handles adaptive web research, vendor websites and logos, Product
enrichment, and logged-in retailer investigation in the member's browser.
These gaps enter the shared Work queue for the member's session to pick up;
queue membership does not launch a session. Follow [Burn-down](burn-down.md)
for that workflow. The Vendor Research queue selects missing websites and
logos, including ordinary Vendors created only as Brands before any Purchase.
Generic / Unbranded is exempt from both checks and does not enter that queue. A supported website
exception closes that gap without suppressing independent logo research.

People resolve material ambiguity and conflicting accepted facts. Supported
unambiguous work should complete automatically within the Mail import switch
and the AI budget; review should explain the unresolved choice and exact impact,
rather than ask the person to repeat a judgment the evidence already settles.
Physical receiving remains an explicit human action.

Executor choice never grants access to another member's originals or expands
the AI budget. Runtime and tool availability can narrow the eligible path;
a guide cannot enable an unsupported writer or bypass its review contract.

## Dependencies and resumption

Dependencies belong to actions, not to an entire record's completeness score.
A missing Vendor website may block a domain-based mail search. A missing logo
is independent research and does not block mail import or settlement. A known
receipt sender can support discovery even without a website.

Use the generic data exceptions when research establishes that a fact is
unavailable or not applicable. Record what was checked and why. An exception
closes that research gap; it does not supply the missing fact or prove that a
dependent search ran. Changed evidence can make an exception stale.

After research, review or posting changes a prerequisite, re-evaluate the
affected work from current evidence. Resume newly eligible work that is
already enabled, within the AI budget. Preserve explicit
pauses and completed receipts; replay-safe wakeups must not create duplicate
imports, spending or execution. A prerequisite's completion is a reason to
recheck eligibility, not permission to repeat every downstream operation.

Reuse Run execution references for continuation. Store only intent that cannot
be reconstructed from those records; derive readiness from current
prerequisites. Recheck the Mail import switch, Run liveness and the AI budget
before dispatch. Recovery must also find eligible continuations after a missed
wakeup. Discovery recomputes its Vendor and transaction targets on every pass,
so research that adds a verified sender needs no separate wake. Explicit pauses
and completed receipts never reopen.

## Show the flow and its effects

The queue is the scannable overview: record identity, reason, Executor, Owner
and actions. Opening an item shows its evidence and supported commands in the
record's own workspace; record pages and Run progress read the same rows.
Reuse report timelines for the overall journey and DecisionSteps for the
member's decisions before one apply; DecisionStep status is not the lifecycle
of a background job. Clients do not reconstruct eligibility or a second
workflow from labels.

Inspection is passive. Run links open retained progress and transcripts.
Conversation observations read retained storage without constructing an agent
harness; prompts and execution controls remain explicit writes.

Use a compact sequence with dependency links when work branches. Keep
independent gaps separate, and distinguish needs input, waiting for an external
event, paused, running, failed and completed outcomes. Failures retain their
raw diagnostics and supported recovery action. A completed step links to the
actual result and recorded changes, rather than leaving a forecast as proof.

Expected effects come from command declarations and server previews where
current inputs are required. Existing prepared-import forms have effect notes;
they are not yet a universal structured impact contract. Show affected records and known money or inventory
changes before an action, and committed results afterwards. Automatic actions
need the same inspectable explanation without adding a confirmation dialog to
every supported write. Existing finance and identity contracts still own what
may change; the shared UI presents their verdicts.

Resolved work leaves actionable views. Its evidence, decisions, receipts and
outcomes remain in the owning record and Run history, without introducing a
second completed-task ledger.

### Activity entry point

Activity’s Needs you view embeds the existing human-review and Problems
queues with their canonical queries, group actions and affected-record
navigation. Its Now view retains automatic recovery and ordinary waits;
persistent Run stalls and Job failure attention follow existing policies.
All Work queue executor views remain available at `/work-queue`.
Activity History opens retained Runs and audit changes; it is not a second
completed-task ledger. Advanced maintenance holds the nightly pass and
one-off repairs formerly in Settings. Recipe re-parsing previews a bounded
Current/Proposed sample before application; the server recomputes eligibility
at execution, so preview is not a record lock or a frozen write promise.
