import { beforeAll, describe, expect, it } from "vitest";

import {
  compileLoadedEntityDeclarations,
  type DeclarationObject,
  loadEntityDeclarationBundle,
  objectValue,
} from "../generator/entities/declarations";

/**
 * `model.rows` declaration errors (#2607): a `via` that walks past a row
 * set's terminal, a JSON item key the field's schema does not hold, a row
 * set that shadows a relation, a JSON row set over a non-JSON field, and a
 * repository column the relation does not declare (or whose reference is
 * not an entity), and a relation row set over a missing relation or field
 * would each compile SQL that reads nothing, so the generator rejects them.
 */
describe("row-set declarations", () => {
  let declarations: DeclarationObject[];
  beforeAll(async () => {
    ({ declarations } = await loadEntityDeclarationBundle());
  }, 60_000);

  /** Compiles every entity with financialAccount's model sections patched. */
  const compileWith = (patch: DeclarationObject) =>
    compileLoadedEntityDeclarations(
      declarations.map((declaration) => {
        if (declaration.key !== "financialAccount") return declaration;
        const model = objectValue(declaration.model, "financialAccount.model");
        const patched = Object.entries(patch).map(([section, value]) => [
          section,
          {
            ...objectValue(model[section] ?? {}, section),
            ...objectValue(value, section),
          },
        ]);
        return {
          ...declaration,
          model: { ...model, ...Object.fromEntries(patched) },
        };
      }),
    );

  it.each([
    [
      {
        derived: {
          last4: { via: "cards.last4", requiresResult: "missingResult" },
        },
      },
      /requiresResult names missing stored result missingResult/,
    ],
    [
      { derived: { last4: { via: "cards.last4.digits" } } },
      /exactly one terminal/,
    ],
    [
      { derived: { last4: { via: "cards.pin" } } },
      /pin is not a column of cards/,
    ],
    [
      { rows: { transactions: { label: "Rows", json: "cardNumbers" } } },
      /shares its key with a relation/,
    ],
    [
      { rows: { cards: { label: "Card numbers", json: "name" } } },
      /not a stored JSON field/,
    ],
    [
      {
        rows: {
          shares: {
            label: "Shares",
            repository: { owner: { reference: "nope" } },
          },
        },
      },
      /references unknown entity nope/,
    ],
    [
      {
        rows: { shares: { label: "Shares", repository: { amount: "number" } } },
        derived: { last4: { via: "shares.missing" } },
      },
      /missing is not a column of shares/,
    ],
    [
      { rows: { linked: { label: "Linked", relation: "nope" } } },
      /relation nope is not a stored-path relation/,
    ],
    [
      {
        rows: { txns: { label: "Transactions", relation: "transactions" } },
        derived: { last4: { via: "txns.notAField" } },
      },
      /notAField is not a stored field of financialTransaction/,
    ],
  ])("rejects %j", (model, error) => {
    expect(() => compileWith(model)).toThrow(error);
  });

  it("retains the owning result binding for a computed row set", () => {
    const project = compileLoadedEntityDeclarations(declarations).find(
      (entity) => entity.key === "project",
    );
    expect(project?.listFields.derived.attention).toMatchObject({
      shape: "rows",
      requiresResult: "rollups",
    });
  });
});
