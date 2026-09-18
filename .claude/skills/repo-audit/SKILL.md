---
name: repo-audit
description: Run Cubby's full multi-agent repository audit with scoped domain lanes, adversarial verification of every candidate finding, mechanical quality gates, and a synthesized report. Use when the user asks for a full-repo audit, quarterly health review, broad code-quality assessment, or to run the existing repo-audit workflow from Claude or Codex.
---

# Audit the Cubby repository

Run the existing audit contract without duplicating its detailed prompts.

## Prepare

1. Work from the Cubby repository root.
2. Read `README.md`, `AGENTS.md`, and `.claude/workflows/repo-audit.js` completely.
3. Treat `.claude/workflows/repo-audit.js` as the authoritative source for:
   - lane names, scopes, and prompts;
   - finding and verdict schemas;
   - documented carve-outs and false-positive controls;
   - report structure and default path (`/tmp/cubby-repo-audit-report.md`).
4. Accept a user-supplied report path when present.

Do not execute the workflow JavaScript in Codex. Its `phase`, `agent`,
`pipeline`, and `parallel` globals belong to Claude's workflow host; translate
those calls into the current host's subagent operations.

## Run the audit

1. Announce that the full audit uses delegated agents and can take time.
2. Fan out the workflow's independent audit lanes with subagents, respecting the
   host's concurrency limit. Invoking this skill explicitly authorizes this
   delegation. Use the current/default model unless the user requests another;
   do not copy Claude model names into Codex configuration.
3. Require every lane to return the workflow's `FINDINGS_SCHEMA`. Preserve an
   empty findings list rather than padding weak observations.
4. Run the mechanical `gates` lane exactly as written. Treat command output as
   ground truth and do not send it through adversarial verification.
5. For every other candidate finding, delegate a fresh adversarial verifier
   using the workflow's verifier prompt and `VERDICT_SCHEMA`. Give the verifier
   the candidate plus repository access, not the auditor's hidden reasoning.
6. Drop refuted findings. Re-grade confirmed severity using the verifier's
   result and deduplicate overlapping findings before synthesis.
7. Delegate or perform synthesis using the workflow's final report prompt.
   Write the complete Markdown report to the selected path and return a concise
   summary with severity counts and the highest-priority findings.

## Guardrails

- Audit read-only. Do not implement fixes during the audit.
- Ignore `.claude/worktrees`, `$CODEX_HOME/worktrees`, `node_modules`, generated
  files, and build outputs as the workflow requires.
- Preserve Cubby's single-user scope and documented architectural decisions.
- Cite exact repository-relative paths and line numbers for confirmed findings.
- Report clean lanes as clean; do not invent findings to fill a quota.
