import { beforeAll, describe, expect, it } from "vitest";

import {
  compileLoadedEntityDeclarations,
  type DeclarationObject,
  loadEntityDeclarationBundle,
  objectValue,
} from "../generator/entities/declarations";

/**
 * `model.derived` rollups compile into correlated aggregates. A rollup over a
 * single record, a count that ends in a field, an aggregate of a field it
 * cannot aggregate, or an `absent` field the related entity does not store
 * would compile SQL that reads the wrong thing, so the generator rejects them.
 */
describe("rollup declarations", () => {
  let declarations: DeclarationObject[];
  beforeAll(async () => {
    ({ declarations } = await loadEntityDeclarationBundle());
  }, 60_000);

  /** Compiles every entity with vendor's `model.derived` extended by `derived`. */
  const compileWith = (derived: DeclarationObject) =>
    compileLoadedEntityDeclarations(
      declarations.map((declaration) => {
        if (declaration.key !== "vendor") return declaration;
        const model = objectValue(declaration.model, "vendor.model");
        return {
          ...declaration,
          model: {
            ...model,
            derived: {
              ...objectValue(model.derived ?? {}, "derived"),
              ...derived,
            },
          },
        };
      }),
    );

  it.each([
    [
      { rollupProbe: { rollup: "count", via: "defaultSpendingCategory" } },
      /leads to a single record/,
    ],
    [
      { rollupProbe: { rollup: "count", via: "purchases.date" } },
      /end the path at a relation/,
    ],
    [
      { rollupProbe: { rollup: "sum", via: "purchases" } },
      /needs the path to end in a stored field/,
    ],
    [{ rollupProbe: { rollup: "sum", via: "purchases.date" } }, /cannot sum/],
    [
      {
        rollupProbe: {
          rollup: "count",
          via: "expenses",
          absent: ["notAField"],
        },
      },
      /absent notAField is not a stored field of expense/,
    ],
  ])("rejects %j", (derived, error) => {
    expect(() => compileWith(derived)).toThrow(error);
  });

  it("compiles a count with an absent filter and a dated extreme", () => {
    expect(() =>
      compileWith({
        unpricedProbe: { rollup: "count", via: "expenses", absent: ["cost"] },
        latestProbe: { rollup: "max", via: "purchases.date" },
      }),
    ).not.toThrow();
  });
});
