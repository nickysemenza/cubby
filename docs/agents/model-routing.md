# Agent model and context routing

## Delegate or not

Work directly by default. Each spawn adds a separate context, repeated setup
reads, and coordination. A serial hand-off must earn that overhead.
Delegation pays only for:

- two or more independent tracks that run in parallel;
- a broad read-heavy sweep whose raw output would flood the main context;
- an approved implementation with several independent units or a long
  mechanical body (the default lane). The main agent implements
  small or single-file changes itself.

Anything a handful of tool calls covers stays in the main session — a lookup in
a known file, a small plan, a focused test. Each spawn should earn its setup and context cost. Parallel lanes suit
read-heavy work; write lanes own disjoint worktrees or stay in the main thread.
Run at most two implementation lanes at once on one machine: each builds,
typechecks and starts test services, and more lanes contend for CPU and the
test harness instead of finishing sooner. Queue further units behind them.
Independent review is selected by risk below; it is not a routine spawn for every PR.

## Lanes

Preserve an explicit user model choice and the current main session. Provider
configuration is host state; these supported pairs are the Cubby routing
contract. Each lane names one Anthropic and one OpenAI pair; either provider
may do any lane. Keep to three lanes to limit repeated setup and coordination.

| Lane                                                                  | Anthropic                         | OpenAI               |
| --------------------------------------------------------------------- | --------------------------------- | -------------------- |
| Default: implementation, diagnosis, identity and money judgment, docs | opus (Opus 5.5) / medium          | `gpt-6.1-sol` / low  |
| Search and extraction whose raw output would flood the main context   | haiku (Haiku 5.5) / low           | `gpt-6-luna` / low   |
| Independent review, when selected                                     | fable (`claude-fable-5-1`) / high | `gpt-6.1-sol` / high |

Raise effort before changing model: the default lane runs at high (opus) or
medium-to-high (Sol) for production financial writes, identity merges,
migrations, and write-path enforcement, and drops back afterwards.

Use independent review when the user requests it or the change carries material
correctness risk: production financial writes, identity merges, migrations,
security boundaries, concurrency enforcement, or major infrastructure. Routine
UI, icon, token, and behavior-preserving cleanup can finish with main-agent
self-review and focused validation. Do not automatically send every change to
Astra or Fable, or add review rounds because a provider is unavailable. An
explicit user instruction can waive a review; preserve it across the task.

When independent review is selected, the reviewer is a different model from the implementer; prefer the other
provider when both are available (an Opus implementation gets a Sol review, a
Sol implementation gets a Fable review). From T3 use `delegate_task` with the
reviewer's provider and model, role `review`; from plain Claude Code reach Sol
through the `codex:codex-rescue` agent (`/codex:rescue`). Give it a
self-contained brief (goal, diff range, risks) and address its real findings.
The brief tells the reviewer to load `code-review`, whose standards sources are
`AGENTS.md`, [generic paths](generic-paths.md), [domain rules](domain-rules.md),
and [validation](validation.md); a diff touching visible web UI also loads
`impeccable` (critique) against `apps/web/DESIGN.md`.
Follow-up review targets fixes and unresolved objections; expand the scope when
a fix changes another contract. Reuse unchanged validation evidence.
A production migration or major infrastructure change (CI, deploy, the Worker
topology, the test harness, or auth) adds a second review by the other
provider's reviewer, or `gpt-6-astra` / high. When implementation and review
disagree on something material, fable / high rules on both positions and the
evidence.

Sonnet, Terra, and Luna are not implementation lanes. The full-repository
audit (`.agents/skills/repo-audit`) is the one exception: its workflow declares
its own measured audit lanes. The production research runtime's Luna/Sol
routing (#1803) is separate from this agent routing.

Search and extraction lanes run at low effort; diagnosis and review lanes start
at their table effort. Escalate when evidence conflicts or a diagnosis has a
demonstrated gap. Do not escalate just because the repository is large. Use
`xhigh`/`max` only where a quality gain was measured.

Claude main sessions use `.claude/settings.json`; Codex uses
`.codex/config.toml` for routine effort and leaves the main model user-owned.
A session's explicit model or effort choice wins; hosts may supply explicit
launch overrides, so repository defaults alone do not prove effective settings.
`.claude/settings.json` sets `CLAUDE_CODE_SUBAGENT_MODEL` to `opus`, so a Claude
subagent spawned without an explicit model lands on the implementation lane;
search lanes name haiku explicitly.

## Before delegation

Load this file before spawning. Assign the lane's explicit model and supported
effort; do not inherit a model by default. A plan with no subagents says "main
agent" once. A plan that delegates names each lane's owner, host assignments,
owned files, dependencies, and validation owner. Lanes use disjoint edits or an
explicit shared-file handoff. Mechanical edit scripts check an explicit allowed-path
set, including every required owner file and reserved-file exclusions, before
any write; check it again immediately before each write and audit the resulting
diff against that same scope. A rejected write must report any earlier partial
edits. Keep architecture, migrations, final integration,
and the one root final check with the main agent. A verification lane re-reads
only what the main agent has not already read; an independent reviewer reads
whatever it needs, but reuses the implementer's validation results instead of
rerunning them.

Subagents report allowlist additions, dependency setup and implementation
blockers to the parent in their progress or handoff; they do not open a user
question for these engineering decisions. The parent resolves them within the
approved scope and keeps file ownership disjoint. Only a material change to the
user's approved outcome or constraints goes back to the user.

## Context and tool output

Start with the requested outcome and a bounded search for its owner. Read the
matching section and direct dependencies; expand when a named uncertainty,
failure or changed contract requires it. An unrelated subsystem is not required
reading merely because a router lists it. Reuse unchanged reads.

At handoff or compaction, retain the goal, owned files/symbols, decisions,
validation commands and covered inputs, limitations, and next unresolved question.
Resume from that checkpoint; re-read changed inputs or missing evidence. Keep
related diagnosis together; start unrelated tasks in a fresh session.

Give delegated work a self-contained brief, targeted paths, exclusions,
completion criterion and return shape, rather than full history. Return findings
with file/line evidence, commands, duration and limits; omit transcripts.
Independent reviewers may explore freely, but reuse valid check results.

For verbose commands, save full output under ignored `artifacts/` and return
status plus failure excerpts. Select fields and page records before returning
MCP results. Bound the combined output of batched calls; truncation requires
targeted read-back. Read status or structured text for nonvisual browser questions;
request screenshots when appearance is the question.

Use host completion notifications for CI/jobs where available; otherwise use a
bounded wait. Re-read only when status changes. Validation ownership and reuse
follow [validation](validation.md#before-opening-a-pr).

## Host settings and measurement

Repository settings cannot shrink host-injected instructions, tool schemas or
global skill catalogs. Keep required skills discoverable; use host tool search
or on-demand catalogs when the host supports them. The fallback history cap in
`.codex/config.toml` limits tool output, not startup context, and does not
configure Claude. Explicit host/session settings may override repo defaults.

[Issue #2317](https://github.com/nickysemenza/cubby/issues/2317) owns the measured
comparison; instruction word counts alone do not establish token or cost savings.
Use existing host/session usage before adding telemetry:

- Record effective provider/model/effort, host, revision, task outcome and
  enabled instruction, skill and tool sources. Separate always-loaded material
  from references fetched during work.
- Compare representative completed tasks before and after a change. Separate
  uncached input, cached input, output/reasoning where reported, tool-result
  volume, elapsed time, retries and review defects. Label unavailable fields;
  context size alone does not establish billed cost or quota consumption.
- Count each parent session's cumulative usage once; account for child usage
  separately without adding repeated snapshots. Attribute repeated reads and
  checks to the evidence or input change that required them.
- Verify effective settings and required skill discovery in each supported host
  (Codex CLI, Claude Code and T3), including targeted read-back after truncation.
  A repo config change alone does not prove that the host applied it.

Publish aggregate or synthetic evidence only. Keep raw session logs private.
Change one context/routing variable at a time and assess correctness alongside
usage; cheaper setup that causes retries is not a completed-task improvement.
Application runtime model routing is a separate concern.
