# Agent model and context routing

Use the cheapest lane that can independently validate the work. Preserve an
explicit user model choice and the current main session. Provider configuration
is host state; these supported pairs are the Cubby routing contract.

| Work | Codex | Claude |
| --- | --- | --- |
| Targeted search, log extraction, mechanical sanitization | `gpt-6-luna` / low | haiku / default |
| Bounded implementation, focused tests, docs restructure | `gpt-5.6-terra` / medium | sonnet / medium |
| Hard diagnosis, cross-subsystem work | `gpt-6-sol` / high | opus / medium |
| Independent broad or high-risk review | `gpt-6-astra` / high | opus / high |

Escalate when evidence conflicts or a diagnosis has a demonstrated gap. Do not
escalate just because the repository is large. On Claude, raise effort before
changing model; use `xhigh`/`max` only where a quality gain was measured. In
Anthropic's testing Opus 5.5 at medium matched or beat Opus 5 at high, and it
thinks more per turn at a given level, so a carried-over `high` costs more for
little.

Fable is opt-in, not a routine lane: use fable / high only when the user asks,
for a second review of a production migration, money or settlement logic, or a
broad refactor, or to break a disagreement between an Opus review and the
implementation.

When no lane has a stronger need, use `gpt-5.6-terra` / medium on Codex or
sonnet / medium on Claude. These are fallbacks, not a reason to override an
explicit user selection or move the current main session.

## Before delegation

Load this file before spawning. Assign the lane's explicit model and supported
effort; do not inherit a model by default. A small task is main agent only, with
no subagents; list the main agent for both host assignments. Delegate only
independent bounded work that advances the task.

Every implementation plan names its lane owner, both host assignments, owned
files, dependencies, and validation owner. Lanes use disjoint edits or an
explicit shared-file handoff. Keep architecture, migrations, final integration,
and the one root final check with the main agent.

## Compact context

Give a lane its scope, allowed commands, exclusions, completion criterion, and
return shape. Return result, commands, duration, relevant output, and limits;
keep routine output to 2,000–4,000 tokens rather than a transcript. Start from
a self-contained brief and targeted files/searches, not full history. Escalate
diagnosed gaps with the evidence needed to resolve them.

One owner runs each expensive gate. Reuse cached results when inputs have not
changed and use bounded CI waits rather than unchanged polling. Application
runtime model names are unrelated to agent routing.
