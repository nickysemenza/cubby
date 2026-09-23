# Agent model and context routing

## Delegate or not

Work directly by default. Every spawn starts a cold context that re-reads
`AGENTS.md` and the files it needs, and never shares the parent's prompt cache;
spawning one agent and waiting on it is slower and costlier than doing the work.
Delegation pays only for:

- two or more independent tracks that run in parallel;
- a broad read-heavy sweep whose raw output would flood the main context;
- an approved implementation with several independent units or a long
  mechanical body (Sonnet/Terra lane). The main agent implements small or
  single-file changes itself.

Anything a handful of tool calls covers stays in the main session — a lookup in
a known file, a small plan, a focused test. Measured over 30 days of Claude
sessions, half spawned subagents and subagents consumed 47% of all context
tokens, so each spawn should be a deliberate choice. Parallel lanes suit
read-heavy work; write lanes own disjoint worktrees or stay in the main thread.

## Lanes

Use the cheapest lane that can independently validate the work. Preserve an
explicit user model choice and the current main session. Provider configuration
is host state; these supported pairs are the Cubby routing contract.

| Work | Codex | Claude |
| --- | --- | --- |
| Targeted search, log extraction, mechanical sanitization | `gpt-6-luna` / low | haiku / low |
| Bounded implementation, focused tests, docs restructure | `gpt-5.6-terra` / medium | sonnet / medium |
| Hard diagnosis, cross-subsystem work | `gpt-6-sol` / high | opus / medium |
| Independent broad or high-risk review | `gpt-6-sol` / high | opus / high |

Read-only delegated lanes run at low effort. Escalate when evidence conflicts or
a diagnosis has a demonstrated gap. Do not escalate just because the repository
is large. On Claude, raise effort before changing model; use `xhigh`/`max` only
where a quality gain was measured. In Anthropic's testing Opus 5.5 at medium
matched or beat Opus 5 at high, and it thinks more per turn at a given level, so
a carried-over `high` costs more for little.

A Claude session may hand work to Codex through the `codex:codex-rescue` agent
(`/codex:rescue`): a stuck diagnosis, a second implementation or diagnosis pass,
or an independent second review where a different model family adds signal.
Reach for it before Fable. It is a delegation like any other — an independent
track, a self-contained brief, a distilled return — not a routine reviewer.

Use `gpt-6-astra` / high for an independent second review when a Sol review
leaves an evidenced gap, or for exceptionally consequential changes such as a
production migration or money and settlement logic. Broad scope alone does not
require Astra.

Fable is opt-in, not a routine lane: use fable / high only when the user asks,
for a second review of a production migration, money or settlement logic, or a
broad refactor, or to break a disagreement between an Opus review and the
implementation.

When no lane has a stronger need, use `gpt-5.6-terra` / medium on Codex or
sonnet / medium on Claude. These are fallbacks, not a reason to override an
explicit user selection or move the current main session.

## Before delegation

Load this file before spawning. Assign the lane's explicit model and supported
effort; do not inherit a model by default. A plan with no subagents says "main
agent" once. A plan that delegates names each lane's owner, host assignments,
owned files, dependencies, and validation owner. Lanes use disjoint edits or an
explicit shared-file handoff. Keep architecture, migrations, final integration,
and the one root final check with the main agent. A verifier re-reads only what
the main agent has not already read.

## Compact context

Give a lane its scope, allowed commands, exclusions, completion criterion, and
return shape. Return result, commands, duration, relevant output, and limits;
keep routine output to 2,000–4,000 tokens rather than a transcript. Start from
a self-contained brief and targeted files/searches, not full history. Escalate
diagnosed gaps with the evidence needed to resolve them.

One owner runs each expensive gate. Reuse cached results when inputs have not
changed and use bounded CI waits rather than unchanged polling. Application
runtime model names are unrelated to agent routing.
