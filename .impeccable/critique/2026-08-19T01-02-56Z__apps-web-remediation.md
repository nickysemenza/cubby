---
target: Cubby authenticated web app remediation
total_score: 37
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 0
timestamp: 2026-08-19T01-02-56Z
slug: apps-web-remediation
---

# Cubby Authenticated Web App — Remediation Critique

Method: dual independent Terra assessments after implementation, followed by one confirmation pass. Assessment A reviewed source, hierarchy, accessibility, and heuristics without detector priming. Assessment B ran the detector and authenticated desktop/phone QA. Both confirmation assessments scored the result 37/40 and reported no remaining P1, P2, or P3 findings in the requested seams.

## Trend

- Previous snapshot: 30/40, two P1 findings.
- Current snapshot: 37/40, zero P1 findings.
- Cleared: navigation overload, systemic phone touch targets, Home/Projects priority, anonymous loading, specialized layout drift, Pantry overflow, Pantry keyboard access, and Project filter chip overload.

## Acceptance Evidence

- Desktop daily navigation is exactly ten choices: Home, four Today tasks, and five primary domain triggers. Settings, account, and Tools & data remain separate footer utilities as required.
- Mobile secondary navigation is task-first, searchable across the complete canonical destination universe, and can transition to utility/developer destinations with Back behavior.
- Home leads with Problems, Needs attention, and four recurring Do now actions. Projects leads with Needs Attention and Next Work; detailed filters live in a responsive dialog.
- Button variants inherit a 40px phone floor. Authenticated phone geometry found no undersized visible Home buttons; planned-meal rows, timestamps, account, and masthead logo were also brought to 40px.
- Loading retains page identity and uses labelled ledger, dashboard, and specification-plate shapes.
- Pantry has no horizontal or vertical overflow: 390×844 document with a 734px surface between 51px top and 59px bottom chrome; 1280×720 document with a 672px surface below the 48px desktop header.
- Pantry exposes a labelled native room selector for keyboard navigation and uses an opaque ruled legend.
- Project historical and completion years use labelled native selects; the three fast relative ranges remain chips.
- `apps/web/DESIGN.md` is unchanged; only the sidecar was refreshed.

## Detector

The detector returned zero findings across changed production UI files. A broader directory scan returned one warning for `border-e-2` in the unchanged Gantt implementation. It is the established semantic edge of an ongoing interval, not a card-side accent, and is outside this remediation diff.

## Final Verdict

No P1 remains. The Warm-Paper Ledger identity is intact, the task hierarchy is materially calmer, mobile controls are motor-accessible, and the specialized Pantry surface now honors the shell and keyboard contracts.
