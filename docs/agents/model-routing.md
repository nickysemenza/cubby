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
The per-PR review below is the one routine spawn.

## Lanes

Preserve an explicit user model choice and the current main session. Provider
configuration is host state; these supported pairs are the Cubby routing
contract. Each lane names one Anthropic and one OpenAI pair; either provider
may do any lane. Keep to three lanes to limit repeated setup and coordination.

| Lane                                                                  | Anthropic                         | OpenAI               |
| --------------------------------------------------------------------- | --------------------------------- | -------------------- |
| Default: implementation, diagnosis, identity and money judgment, docs | opus (Opus 5.5) / medium          | `gpt-6.1-sol` / low  |
| Search and extraction whose raw output would flood the main context   | haiku (Haiku 5.5) / low           | `gpt-6-luna` / low   |
| Independent review, one per PR                                        | fable (`claude-fable-5-1`) / high | `gpt-6.1-sol` / high |

Raise effort before changing model: the default lane runs at high (opus) or
medium-to-high (Sol) for production financial writes, identity merges,
migrations, and write-path enforcement, and drops back afterwards.

The reviewer is a different model from the implementer; prefer the other
provider when both are available (an Opus implementation gets a Sol review, a
Sol implementation gets a Fable review). From T3 use `delegate_task` with the
reviewer's provider and model, role `review`; from plain Claude Code reach Sol
through the `codex:codex-rescue` agent (`/codex:rescue`). Give it a
self-contained brief (goal, diff range, risks) and address its real findings.
Follow-up review targets fixes and unresolved objections; expand the scope when
a fix changes another contract. Reuse unchanged validation evidence.
A production migration or major infrastructure change (CI, deploy, the Worker
topology, the test harness, or auth) adds a second review by the other
provider's reviewer, or `gpt-6-astra` / high. When implementation and review
disagree on something material, fable / high rules on both positions and the
evidence.

Sonnet, Terra, and Luna are not implementation lanes. The full-repository
audit (`.claude/skills/repo-audit`) is the one exception: its workflow declares
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
explicit shared-file handoff. Keep architecture, migrations, final integration,
and the one root final check with the main agent. A verification lane re-reads
only what the main agent has not already read; an independent reviewer reads
whatever it needs, but reuses the implementer's validation results instead of
rerunning them.

## Compact context

During multi-stage work, retain the goal, owned files/symbols, decisions,
validation evidence, and next unresolved question. After compaction or handoff,
resume from that checkpoint and re-read only changed inputs or missing evidence.
Keep related implementation and diagnosis together; unrelated work starts a
fresh session. Do not repeatedly reset a task and pay for the same discovery.

Give a lane its scope, allowed commands, exclusions, completion criterion, and
return shape. Return result, commands, duration, relevant output, and limits;
return findings with file/line evidence rather than transcripts. Start from
a self-contained brief and targeted files/searches, not full history. Escalate
diagnosed gaps with the evidence needed to resolve them.

For verbose commands, save full output under ignored `artifacts/` and return
status plus relevant excerpts. Select fields and page records before returning
MCP results. Budget the combined output of batched calls; truncation requires
targeted read-back before drawing a conclusion. Runtime tool-output and skill
catalog budgets live in `.codex/config.toml`; they do not reduce host-injected
instructions or configure Claude. Keep concise progress and completion reports.

Use host completion notifications for CI/jobs where available, otherwise one
bounded wait; unchanged polling adds no evidence. Validation ownership and
reuse follow [validation](validation.md#before-opening-a-pr). Application runtime
model names are unrelated to agent routing.
