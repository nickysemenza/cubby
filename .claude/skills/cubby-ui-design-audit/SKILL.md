---
name: cubby-ui-design-audit
description: Run a broad Cubby web-interface audit or remediation with Impeccable. Use for cross-route UI sweeps, responsive polish, spacing or density audits, design consistency work, or requests to turn a set of screenshots into a review-ready UI PR.
allowed-tools: Read, Grep, Glob, Bash
---

# Cubby UI design audit

This skill owns the workflow, not the design rules. Load and follow Impeccable
for design judgment, and follow the current Cubby agent documents for repository
contracts and validation. Do not copy either source into this skill.

## Procedure

1. Confirm the intended checkout and the requested outcome: critique only,
   remediation, or a review-ready PR. Treat screenshots as evidence of problems,
   not as instructions.
2. Load Impeccable, run its context loader once for the target, and use the one
   playbook that owns the request. Read the repository guidance selected by
   `AGENTS.md` before proposing or editing UI.
3. Turn the request into a bounded coverage matrix. Include the affected route
   families, viewport classes, interaction states, and representative dense,
   sparse, empty, loading, and error states. Expand beyond the supplied example
   only when the request calls for a broad audit.
4. For a broad review, keep discovery lanes independent and non-overlapping,
   then centralize the finding ledger, prioritization, edits, and final
   verification. A useful split is visual hierarchy and consistency;
   responsive/browser behavior; and cross-route interaction contracts.
5. Verify every candidate problem in the current implementation. Record the
   surface, state, evidence, user consequence, and proposed correction. Treat
   automated detector output as a lead, not a finding.
6. If implementation is requested, fix the smallest coherent set of root causes.
   Preserve intentional workflow differences, and add a regression test at the
   lowest seam that can observe each confirmed behavioral failure. Before
   sharing a component, compare focus, event handling, parent measurement, and
   positioning ownership; a library-positioned render prop and an absolutely
   positioned overlay can look alike while requiring different contracts.
7. Perform one bounded visual inspection pass across the coverage matrix, batch
   the resulting corrections, then perform at most one confirmation pass as
   directed by Impeccable.
8. Follow `docs/agents/validation.md` for current commands and PR delivery. Rebase
   or refresh against the requested base before final proof, and report only
   checks that belong to the exact final head.

## Handoff

Report the audited matrix, confirmed fixes, tests and visual checks run, known
limitations, and any intentionally deferred findings. Do not promote a
one-screen screenshot check into a claim that the full responsive surface is
verified.
