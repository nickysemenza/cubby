# Agent model and context routing

## Delegate or not

Work directly by default. Every spawn starts a cold context that re-reads
`AGENTS.md` and the files it needs, and never shares the parent's prompt cache;
spawning one agent and waiting on it is slower and costlier than doing the work.
Delegation pays only for:

- two or more independent tracks that run in parallel;
- a broad read-heavy sweep whose raw output would flood the main context;
- an approved implementation with several independent units or a long
  mechanical body (the Opus implementation lane). The main agent implements
  small or single-file changes itself.

Anything a handful of tool calls covers stays in the main session — a lookup in
a known file, a small plan, a focused test. Measured over 30 days of Claude
sessions, half spawned subagents and subagents consumed 47% of all context
tokens, so each spawn should be a deliberate choice. Parallel lanes suit
read-heavy work; write lanes own disjoint worktrees or stay in the main thread.
The per-PR review below is the one routine spawn.

The [2026-10-08 recheck](../dev-tooling-evidence.md#routing-measurement) recorded
44.6% of sessions delegating and 56.2% of recorded token usage in subagents.
It mostly predates this rule and does not establish a speed/quality improvement;
the 47% figure above is the historical baseline, not a current measurement.

## Lanes

Preserve an explicit user model choice and the current main session. Provider
configuration is host state; these supported pairs are the Cubby routing
contract.

| Work                                                      | Model / effort                              |
| --------------------------------------------------------- | ------------------------------------------- |
| Implementation, focused tests, docs (the default lane)    | Claude opus (Opus 5.5) / medium             |
| Targeted search, log extraction, mechanical sanitization  | haiku / low, or `gpt-6-luna` / low on Codex |
| Hard diagnosis, cross-subsystem work                      | opus / medium                               |
| Independent review of every PR                            | `gpt-6.1-sol` / high                        |
| Second review: production migration or major infra change | `gpt-6-astra` / high                        |
| Implementation and review disagree on something material  | fable (`claude-fable-5-1`) / high           |

Opus at medium implements whatever the main session delegates, including long
mechanical bodies; Sonnet and Terra are no longer routine implementation lanes.
The full-repository audit (`.claude/skills/repo-audit`) is the one exception:
its workflow declares its own measured audit lanes.
A Codex main session reaches the Opus lane through T3 `delegate_task`.

Every PR gets one Sol review before merge: a different model family from the
Opus implementation, so it is the independent cross-model check. From T3 use
`delegate_task` (provider `codex`, model `gpt-6.1-sol`, `reasoningEffort`
high, role `review`); from plain Claude Code use the `codex:codex-rescue` agent
(`/codex:rescue`). Give it a self-contained brief (goal, diff range, risks) and
address its real findings.

Add an Astra review only for a production migration or a major infrastructure
change (CI, deploy, the Worker topology, the test harness, or auth). Broad
scope alone does not require Astra.

Fable is a tie-breaker, not a reviewer: use fable / high only when the
implementation and a review disagree on something material. Give it both
positions and the evidence, and follow its ruling.

Search and extraction lanes run at low effort; diagnosis and review lanes start
at their table effort. Escalate when evidence conflicts or a diagnosis has a
demonstrated gap. Do not escalate just because the repository is large. On
Claude, raise effort before changing model; use `xhigh`/`max` only where a
quality gain was measured. In Anthropic's testing Opus 5.5 at medium matched or
beat Opus 5 at high, and it thinks more per turn at a given level, so a
carried-over `high` costs more for little.

`.claude/settings.json` sets `CLAUDE_CODE_SUBAGENT_MODEL` to `opus`, so a Claude
subagent spawned without an explicit model lands on the implementation lane;
search lanes name haiku explicitly.

## Before delegation

Load this file before spawning. Assign the lane's explicit model and supported
effort; do not inherit a model by default. A plan with no subagents says "main
agent" once. A plan that delegates names each lane's owner, host assignments,
owned files, dependencies, and validation owner. Lanes use disjoint edits or an
explicit shared-file handoff. Keep architecture, migrations, final integration,
and the one root final check with the main agent. A verification lane re-reads
only what the main agent has not already read; an independent reviewer reads
whatever it needs, but reuses the implementer's validation results instead of
rerunning them.

## Compact context

Give a lane its scope, allowed commands, exclusions, completion criterion, and
return shape. Return result, commands, duration, relevant output, and limits;
keep routine output to 2,000–4,000 tokens rather than a transcript. Start from
a self-contained brief and targeted files/searches, not full history. Escalate
diagnosed gaps with the evidence needed to resolve them.

One owner runs each expensive gate. Reuse cached results when inputs have not
changed and use bounded CI waits rather than unchanged polling. Application
runtime model names are unrelated to agent routing.
