import { parseSync } from "oxc-parser";
import { EntityDeclarationError } from "./declarations.ts";

/** A removed infrastructure table is allowed; new storage belongs in declarations. */
export const validateRetainedTableBoundary = (
  source: string,
  retained: ReadonlySet<string>,
): void => {
  const { program, errors } = parseSync("schema.ts", source);
  if (errors.length)
    throw new EntityDeclarationError(
      "Cannot parse schema.ts storage boundary.",
    );
  for (const statement of program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const variable of declaration.declarations) {
      if (
        variable.id.type !== "Identifier" ||
        variable.init?.type !== "CallExpression" ||
        variable.init.callee.type !== "Identifier" ||
        variable.init.callee.name !== "pgTable"
      )
        continue;
      if (!retained.has(variable.id.name))
        throw new EntityDeclarationError(
          `Handwritten table ${variable.id.name} is outside the shrink-only infrastructure baseline; declare entity children or module storage.`,
        );
    }
  }
};
