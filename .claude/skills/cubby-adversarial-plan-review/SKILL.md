---
name: cubby-adversarial-plan-review
description: Review a Cubby implementation plan against the checkout for missing contracts, unsafe assumptions, and implementation blockers. Use for adversarial plan review or requests to find what is wrong or missing before implementation.
---

# Cubby adversarial plan review

Review the plan against current evidence. Keep a review-only request read-only;
revise or implement only when the user requests that work.

## Procedure

1. Identify the plan, target checkout, and requested finding format. Read the
   complete plan, [model routing](../../../docs/agents/model-routing.md), and
   follow [Cubby agent rules](../../../AGENTS.md) to load the guidance for its
   affected domains.
2. Extract the claims that determine whether the plan can work: existing
   behavior, proposed interfaces, ownership, migrations, acceptance checks, and
   execution lanes. Verify each against code, schema, tests, or configuration.
   A citation in the plan is a lead to inspect, not proof of the claim. For an
   implementation plan, require a lane owner, both host assignments, owned
   files, dependencies, and validation owner for every lane; a small task may
   keep all of these with the main agent.
3. Trace affected contracts across public inputs/outputs, success and refusal
   behavior, transactions, persisted projections, lifecycle operations,
   telemetry, UI state, and test coverage. Focus on boundaries the plan changes.
   In particular:
   - Registration counts do not establish behavioral parity. Compare batch,
     preview, success payload, idempotency, and transaction behavior by family.
   - Changing projection code does not rewrite stored rows. Identify any
     required repair path and how completion will be verified.
   - Relationship metadata does not establish executable mutation or lifecycle
     policy. Trace the handler and its transactional enforcement.
   - Main agent only is the right answer for a small plan. Each delegated lane
     earns its place under "Delegate or not" in `docs/agents/model-routing.md`
     and needs disjoint edits or an explicit handoff for shared files, an
     explicit model and supported effort, and one root owner for final
     validation.
4. Report confirmed findings in the requested order, each with severity, exact
   file/line evidence, a concrete consequence, and the smallest correction.
   Separate unresolved questions from demonstrated blockers; omit refuted or
   purely hypothetical findings.
5. Give an implementation-readiness verdict and name any unverified boundaries.
   Include a single highest-impact issue when requested. Stop once the plan's
   consequential claims and strongest counterexamples are accounted for.
