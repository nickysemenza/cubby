import { beforeAll, describe, expect, it } from "vitest";

import {
  compileLoadedEntityDeclarations,
  type DeclarationObject,
  loadEntityDeclarationBundle,
  objectValue,
} from "../generator/entities/declarations";

/**
 * `presentation.list.scope`/`scopes` declaration errors (#2610): a static
 * scope over a field the table does not store, a related scope whose path
 * does not end at its `filters` entity's records, an unknown target, and a
 * scope key a filter already uses would each scope by nothing or shadow a
 * filter, so the generator rejects them.
 */
describe("list scope declarations", () => {
  let declarations: DeclarationObject[];
  beforeAll(async () => {
    ({ declarations } = await loadEntityDeclarationBundle());
  }, 60_000);

  /** Compiles every entity with task's `presentation.list` patched. */
  const compileWith = (list: DeclarationObject) =>
    compileLoadedEntityDeclarations(
      declarations.map((declaration) => {
        if (declaration.key !== "task") return declaration;
        const presentation = objectValue(
          declaration.presentation,
          "task.presentation",
        );
        return {
          ...declaration,
          presentation: {
            ...presentation,
            list: {
              ...objectValue(presentation.list ?? {}, "task.presentation.list"),
              ...list,
            },
          },
        };
      }),
    );

  it.each([
    [{ scope: ["nope"] }, /scope names nope, which is not a stored field/],
    [
      { scopes: { projectScope: { via: "subject", filters: "project" } } },
      /via subject does not lead to a project record/,
    ],
    [
      { scopes: { projectScope: { via: "project.name", filters: "project" } } },
      /via project.name does not lead to a project record/,
    ],
    [
      { scopes: { projectScope: { via: "project", filters: "nope" } } },
      /filters names unknown entity nope/,
    ],
    [
      { scopes: { status: { via: "project", filters: "project" } } },
      /scopes.status shares its key with a filter/,
    ],
  ])("rejects %j", (list, error) => {
    expect(() => compileWith(list)).toThrow(error);
  });
});
