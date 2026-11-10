# ADR 0016: Shared Assessments and Feedback

Status: Superseded by [ADR 0025](0025-radical-simplification-of-background-work.md).
Accepted 2026-10-15.

## Decision

Field suggestions, Email review and accuracy grading, image-description
corrections, Product matches and recommendation Dismissals shared one review
loop: an Assessment recorded a reproducible judgment with its subject, producer
and evidence fingerprint, Feedback recorded a member's verdict and optional
correction, and typed domain handlers applied the actual field update, Email
correction or Product merge. ADR 0025 replaced that storage with one
`Suggestion` table whose `decisions` hold member and automatic decisions, and
removed read publications and automatic correction propagation. The current
contract lives in [Shared proposal queue and automatic decisions](../entities.md#shared-proposal-queue-and-automatic-decisions);
the transfer-pair clean policy lives in the
[household contribution ledger](../household-contribution-ledger.md#opposite-leg-clean-policy).

The full text is in git history.
