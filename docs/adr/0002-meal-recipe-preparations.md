# Use Meal Recipe occurrences as preparations

A physical preparation belongs to one existing Meal Recipe occurrence rather than a separate batch entity, keeping the common planning-to-cooking flow to two yield fields and one portion table. One occurrence can represent at most one preparation; repeat cooks use another Meal Recipe row, cost and nutrition estimates always follow the current Recipe data, and deleting the source Recipe, Meal, or occurrence also deletes its portions. This deliberately trades immutable intake history and independently addressable batches for a smaller household workflow and data model.

Portions record their entered quantity and unit. Weight, serving count, and batch
share are alternative inputs resolved from current preparation/recipe data on
read; none is converted into another stored basis. A serving-count correction
therefore updates the share of existing serving entries. See ADR 0003 for the
shared meal amount and missing-conversion behavior.
