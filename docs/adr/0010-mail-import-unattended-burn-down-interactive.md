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
private ownership. `activity_read.for_member` offers only the authenticated member's
eligible work plus shared work, before counts and pagination. Routing follows
current source/account authority rather than inventory ownership or historical
actor snapshots; private originals keep their existing access checks. Queue
reads create no records, launch no inference and authorize no execution.
Automatic maintenance remains in its existing controls.

## Amendment: automatic routine work (2026-10-17)

Automatic maintenance recovers missed queue publications on app open and daily.
Related retained Emails from enabled connected mailboxes enter import automatically,
including unclaimed Email classified before automatic admission was introduced.
MCP mutations allowed by a Run's capabilities execute without per-operation
approval or approval bindings. Stable operation IDs, exact-input replay checks,
member/source ownership, transaction fences and audit receipts remain enforced.
There is no approval pause. A Run that held one is member `paused` and resumes
through the normal dispatch path; its never-executed operations are `failed`
and are re-issued under new operation ids. Approval history remains stored.
Photo group review and ambiguous business choices keep their domain review
flows.

## Mail import outcome measurement

Each delegated Email settlement stores an immutable `mailOutcome` on its
`target_outcome` RunOperation with its checksum, Run, producer and terminal
disposition. Imported
lines and totals freeze the actual Expense ledger, including credits, across
all Purchases reached for that Email by the commit. A multi-order commit links
each Purchase, then publishes one complete Email outcome; operation replay
reuses it. The total remains `SUM(Expense.cost)`. Linked outcomes freeze the actual targets' order and
Vendor names; replay compares those identities across databases and reports missing
identity as unavailable. Rules retain their revision. The public writer has no
causal model receipt, so agent outcome model attribution remains null. Never
infer it from the latest Run usage: asynchronous telemetry or an earlier turn
can name the wrong model after escalation or funding recovery. Evaluator reports
show observed Run-level model usage separately, including parity cases; that is
routing evidence rather than per-outcome producer attribution. Retries reuse
the first producer and evidence. `EmailReview`
records history-only grades and never rewrites the ledger or Email disposition.
The outcome read exposes its producing Run as a shortcode; its handle stays an
opaque grading id.

The local Mail replay evaluator copies supplied retained originals into a fresh
throwaway database per case and runs the real coordinator and public writers.
It publishes no production records. Its session-only stdin transport and reports
keep originals and entity handles out of files; reports show parity counts and
disagreement case positions/fields, plus bounded diagnostics and explicit usage
measurements. Version 2 labels cost as all Run-scoped AI features, reports known
standard cost separately from charged cost and missing prices, and retains
token/cache counts and durations without source text. Re-capture both comparison
baselines under that version; older coordinator-only cost reports are not
comparable. Synthetic parity gates disposition, totals, line-cost multisets and
supported links; free-form line names and unresolved reasons remain review
differences. These checks do not establish Product identity or full itemization. Existing Purchases, catalog, attachments
and supporting Emails are not copied, so a replay with those dependencies is
context-limited rather than evidence of a model regression. The decision-grading
skill owns blind review and member-confirmed MCP grading. Replay observation runs
before Worker teardown on both completion and failure; timeouts retain observed
successful-call models while their outcome remains unavailable rather than
counting as parity.

Production runs Luna as the primary and Opus as the preferred escalation model. A graded
replay of 20 held-out import Emails matched Opus on every total Luna imported
(differences were line names, $0 shipping lines, and split rather than netted
discounts), and 9 of 10 unresolved Emails agreed. Linking to existing Purchases
was not measurable in replay. Candidate settings remain harness-only overrides
(`MAIL_REPLAY_MODEL`) until real replay and member grading justify a change.
Haiku 5.5 as both primary and escalation model, on the same 20 Emails, imported
9 (Luna 16), with 3 totals differing from Opus, and left 10 unresolved that
Opus imported; at about $0.005 per Email it cost no less than Luna, so it is not
a candidate.
With distinct primary and escalation models, an Email escalates only on an
explicit request for a repairable extraction, identity or evidence-contradiction
problem, or an unclassified reasoning gap. Missing originals, member decisions,
held sources and transient execution failures do not justify stronger reasoning.
This replaces blanket escalation on two refused preparations or before every
unresolved disposition: stronger reasoning cannot recover absent evidence or
supply authority. Source-specific gaps settle without stopping unrelated work.

A claim returning another Email returns to the primary; re-claiming the same
unsettled Email keeps its escalation. While escalation funding refuses, the
primary handles the Email unless the existing Sol alternative can use free
funding. A known Claude credit refusal selects funded Sol before transmission
instead of spending a failed Claude call to reach the provider ladder's same
alternative. The funding decision and selected model are retained per Email.
Model transitions retain a pending/applied configuration receipt. Recovery
reconciles the desired model before accepting a replayed escalation or next-Email
reset. Pending transitions reapply idempotently because a failed configuration
may already have taken effect. Existing stored escalation decisions survive the
policy cutover. The coordinator mechanically bounds extraction submissions by
source checksum: initial extraction plus one repair on the primary and one
escalated submission. Invalid tool arguments count too; replaying the same call
does not. Exhaustion publishes a gap through the ordinary checksum-bound writer.
Attempt receipts live in Run operations and remain authoritative across successor
Runs. Only the trusted claim establishes their evidence version; display names
and Purchase date corrections do not renew it. Writer refusal classification
uses server metadata, never matching error codes in Email text. Held-source
refusals do not spend semantic attempts. An uncertain writer outcome retains its
reservation and permits bounded identical-operation recovery before changed input.
The bundled ordinary tool owns stable preparation/commit identities and returns
the next durable claim after known publication. New retained source bytes or
accepted evidence of the exact own-account order may reopen an untouched
automatic gap through discovery, preserving earlier rosters, outcomes and member
intent. Unchanged source/evidence fingerprints never schedule another attempt.
