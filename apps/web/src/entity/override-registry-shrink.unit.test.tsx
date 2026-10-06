import { describe, expect, it } from "vitest";

import { loadEntityDeclarations } from "../../../../scripts/generator/entities/declarations";
import { editHooks } from "./editing/definitions";
import { listOverrides } from "./list-columns/list-overrides.test-fixture";

/**
 * The hand-written halves of an entity — its list override module and its
 * editing hooks — exist for what a declaration cannot say. Both registries
 * may only SHRINK: a new entity (or a new member of an old one) reaches for
 * the declaration (`display.*`, `model.intents`, `control.*`) and a generic
 * renderer first, per the "Generic by default" rule in AGENTS.md.
 *
 * To remove an entry, delete it here and in the registry. Never add one; if a
 * capability is missing, add it to the entity declaration and the generic
 * runtime instead.
 */
const LIST_OVERRIDE_BASELINE: readonly string[] = [
  "cookbook",
  "expense",
  "financialAccount",
  "financialTransaction",
  "image",
  "ingredient",
  "inventory",
  "location",
  "meal",
  "product",
  "purchase",
  "recipe",
  "run",
  "task",
  "wish",
];

const EDIT_HOOK_BASELINE: readonly string[] = [
  "expense.create.capture",
  "expense.create.full",
  "expense.update.cost",
  "expense.update.date",
  "expense.update.full",
  "expense.update.planned",
  "expense.update.settle",
  "financialAccount.create.capture",
  "financialAccount.create.full",
  "financialAccount.update.full",
  "financialTransaction.create.capture",
  "financialTransaction.create.full",
  "financialTransaction.update.full",
  "location.create.capture",
  "location.create.full",
  "location.fields.collections",
  "location.update.full",
  "product.fields.externalIds",
  "product.fields.isbn",
  "product.fields.labelNutrition",
  "product.fields.unitMappings",
  "product.fields.upc",
  "task.fields.notes",
];

const hookMembers = Object.entries(editHooks).flatMap(([entity, hooks]) =>
  Object.entries(hooks).flatMap(([section, members]) =>
    Object.keys(members).map((name) => `${entity}.${section}.${name}`),
  ),
);

describe("hand-written per-entity registries only shrink", () => {
  it("adds no list override module", async () => {
    const declared = (await loadEntityDeclarations())
      .filter((entity) => entity.route?.listColumns)
      .map((entity) => entity.key);
    // Every production binding retains the hook-stability regression coverage.
    expect(declared.toSorted()).toEqual(Object.keys(listOverrides).toSorted());
    const added = declared.filter(
      (entity) => !LIST_OVERRIDE_BASELINE.includes(entity),
    );
    expect(
      added,
      "declare the columns on the entity (display.*) instead of a list module",
    ).toEqual([]);
  });

  it("adds no editing hook", () => {
    const added = hookMembers.filter(
      (member) => !EDIT_HOOK_BASELINE.includes(member),
    );
    expect(
      added,
      "state it in the entity declaration (model.intents, control.*, edit.*) instead of an edit hook",
    ).toEqual([]);
  });
});
