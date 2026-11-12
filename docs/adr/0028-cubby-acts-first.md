# ADR 0028: Cubby acts first; members correct

Status: Accepted by the owner 2026-11-09. Supersedes the automatic-rule section
of [ADR 0016](0016-shared-assessments-and-feedback.md) and extends item 7 of
[ADR 0025](0025-radical-simplification-of-background-work.md).

## Context

A member looking at a Product table could not tell three chip treatments apart:
a saved value, a value Cubby saved on its own (grey fill, trailing sparkle) and a
pending suggestion (dashed border, leading sparkle). Nothing explained why a
suggestion had not been saved, and Cubby could not revise a value it had set
itself, because any earlier audited write to a field blocked automatic fill.
Nothing evaluated a field when a record was saved: the only automatic trigger
was opening a page.

The owner's direction: Cubby should do the work on its own; when something is
wrong, the member corrects it, and Cubby learns from the correction and keeps
re-evaluating its own values.

A blind grade of 60 below-bar guesses found the 0.70 to 0.85 band 85% right with
no wrong values, and the band below 0.70 25% right, mostly because fields were
asked where they do not apply (a grocery asked which plant it grows).

## Decision

1. **Cubby acts when it can take the action back with one write and no person
   has said otherwise.** It waits when an action merges or deletes a record,
   books money on a judgment, moves stock, or contradicts a person. When unsure it
   leaves things as they are without asking. Product merges, statement attach,
   placement moves and new vocabulary stay manual. Fields declare who decides a
   confident answer: `apply: "auto"` (Cubby saves it), `"review"` (a member
   applies it) or `"offer"` (it waits as the picker's guess).
2. **Authority is recorded on the write.** `AuditLog.authority` is `automatic`
   for Cubby's own field writes and `released` when a member hands a field back.
   Null means a person, an import or an agent wrote it. One function,
   `fieldAuthority`, reads the newest audit row for the field: `open` (nothing
   decided it), `cubby` (Cubby wrote the current value and nobody kept it) or
   `person`. Any ambiguity, including an audit row that disagrees with the stored
   value, is `person`. Reads do not carry ownership; Why this value asks for it.
3. **Cubby never overwrites a person's value.** It fills open fields and
   revises its own unconfirmed values. A replacement must beat the runner-up by
   0.20 (with probabilities summing to 1 this is already true for any winner at
   0.60 or more; it states the rule), a value Cubby already replaced is never
   applied again, and fields other records inherit from (`fillOnly`) are filled
   but never revised. The bar stays at 85% until a graded sample shows the
   0.70 to 0.85 band at 90% or better.
4. **An edit is the correction.** A person's write over Cubby's value records a
   Miss with the right value. Keep makes Cubby's value the member's. "Wrong,
   clear it" empties the field, rules the value out and lets Cubby try again.
   "Let Cubby decide" hands a person's value back. An import's replacement is
   evidence, not a grade.
5. **Corrections are learned through precedents, not rules.** A saved record's
   prompt carries up to eight values people set for the same field on records
   sharing a parent, corrections first. Cubby's own unreviewed values are never
   precedents. After a member's correction, Cubby rechecks at most 25 similar
   values it holds; each still has to clear the bar. This replaces ADR 0016's
   measured, member-switched Automatic rules and audit holdback, and the
   `AutomaticRule` table is dropped with no archive by the owner's instruction.
6. **Field work follows events.** One drain reads audit rows flagged
   `automationPending` in the writer's transaction (creates, input changes,
   corrections, hand-backs) and re-asks every open guess and Cubby-held value
   after a model, prompt or policy revision. Page views schedule nothing and
   there is no periodic pass. Edit forms still ask live, because their basis is
   unsaved.
7. **Only questions that apply are asked.** An unclassified record is not asked a
   field its classification refuses by default, and `growsPlantId` is asked only
   under the `planting` category feature.
8. **One saved state on screen.** A value looks the same whoever set it. Guesses
   live in the field's picker as "Cubby's guess"; Needs you holds only member
   decisions (Disagreements, fields that need a member, merge, delete, money,
   stock, contradiction, personal); agent work is the Agent view backlog; Changes by Cubby lists what Cubby
   did. Tuning is an agent procedure (`decision-grading`), not a screen.

## Consequences

Members stop reviewing additions. They see Cubby's changes in one feed and
correct by editing. A wrong prompt change can now re-set many Cubby-held values
at once; the lever replay in `decision-grading` runs before any prompt change
ships, and no-return plus `fillOnly` bound the damage. Records nobody writes
after deploy are evaluated only by a member-started Sweep. Fields declared
`audit: false` cannot be recognised as Cubby's after they are filled.
