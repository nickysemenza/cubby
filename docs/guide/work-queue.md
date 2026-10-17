# One view of the work

The Work queue derives work from records, gaps, findings, execution and review
state. Its All, Automatic, Research, Review and Waiting views share one
server projection with record work sections, including Runs. Views can overlap:
automatic execution can be waiting for a prerequisite. GitHub Issues owns
delivery and remaining domain coverage.

## Shared work, different ways to complete it

The Work queue, a record's work section, and a Run's progress should explain
the same work from different starting points. Automatic work, interactive
research, review and waiting are views over that work. A change of executor
does not create another copy of the underlying problem.

Keep durable evidence, decisions and execution in their existing owners:
entity declarations and data-quality checks describe missing facts; findings
and Assessments retain unresolved decisions; Runs record execution; domain
commands own writes. Extend their shared projections rather than introducing
another task ledger, workflow engine, or entity-specific queue state.
Queue reads explain current work without launching inference or mutations.
The current queue's work kind describes its category, not its execution state;
keep those meanings separate when adding automatic and waiting views.

Each actionable step should explain:

- **Reason:** the record, evidence or failed check that makes it necessary.
- **Readiness:** whether it can proceed, and the specific prerequisite if not.
- **Executor:** automatic Cubby/Pi work, a Claude/Codex session, or a person.
- **Authority:** whose sources, account access or decision it requires.
- **Expected changes:** what it will create, attach, update or remove.
- **Unblocks:** which next actions become eligible after its result is saved.

Readiness, executor and authority are separate facts. A member's name in
Waiting for does not explain a missing prerequisite, and an automated step can
still be waiting for evidence, posting, the AI budget or an explicit
resume. Unknown dependencies and effects stay unknown rather than becoming
invented progress or promises.

A reconciliation investigation is actionable member work even when the
automatic writer lacks evidence. Its preview explains that limitation and the
supported effects; it does not claim execution is scheduled. The shared routing
roster drives both action executors and view membership before pagination.
Running status alone does not establish automatic execution: the execution
adapter requires a Workflow-backed purpose or a retained dispatch event.
Unscheduled interactive Runs keep their domain handoff instead of appearing
as automatic work; authorized Vendor-history prerequisite waits remain visible.

## Choose the executor

Cubby owns deterministic retrieval, replay, validation and derived state. Pi
interprets available import evidence and coordinates supported unattended
work. Jev/Clef make bounded semantic decisions and rank uncertain candidates;
the domain writer independently checks whether a proposed change can apply.

Claude/Codex handles adaptive web research, vendor websites and logos, Product
enrichment, and logged-in retailer investigation in the member's browser.
These gaps enter the shared Work queue for the member's session to pick up;
queue membership does not launch a session. Follow [Burn-down](burn-down.md)
for that workflow. The Vendor Research queue selects missing websites and
logos, including Vendors discovered before any Purchase. A supported website
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

The queue is the scannable overview: record identity, reason, readiness and next
action. Opening an item shows its prerequisite records, evidence and expected
changes in context. Record pages and Run progress consume the same
server-projected explanation. Full explanations use the shared action-details
popover. Virtualized queue rows retain their fixed height; opening details
must not select or open the record. Reuse report timelines for the overall
journey and DecisionSteps for the member's decisions before one apply;
DecisionStep status is not the lifecycle of a background job.
Domain adapters supply their evidence and supported commands; clients do not
reconstruct eligibility or a second workflow from labels.

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
