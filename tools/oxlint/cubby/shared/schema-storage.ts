import { parseSync, type Expression, type Program } from "oxc-parser";

function expressionBody(value: Expression): Expression {
  if (
    value.type === "ParenthesizedExpression" ||
    value.type === "TSAsExpression" ||
    value.type === "TSSatisfiesExpression"
  )
    return expressionBody(value.expression);
  return value;
}

function declarations(program: Program) {
  return program.body.flatMap((statement) => {
    const declaration =
      statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
    return declaration?.type === "VariableDeclaration"
      ? declaration.declarations
      : [];
  });
}

/** Resolve column factories statically; importing a Workers database schema
 * into a Node guard would execute application code and miss build isolation. */
export function softDeleteTableCatalog(
  schemaSource: string,
  columnSources: readonly string[] = [],
) {
  const parse = (source: string) => {
    const result = parseSync("schema.ts", source, { lang: "ts" });
    if (result.errors.length)
      throw new Error("Cannot inspect invalid storage declarations");
    return result.program;
  };
  const schema = parse(schemaSource);
  const allDeclarations = [schema, ...columnSources.map(parse)].flatMap(
    declarations,
  );
  const factories = new Map<string, Expression>();
  for (const declaration of allDeclarations) {
    if (declaration.id.type !== "Identifier" || !declaration.init) continue;
    const init = expressionBody(declaration.init);
    if (
      init.type === "ArrowFunctionExpression" &&
      init.body.type !== "BlockStatement"
    )
      factories.set(declaration.id.name, init.body);
  }
  const hasDeletedAt = (
    value: Expression,
    seen = new Set<string>(),
  ): boolean => {
    const expression = expressionBody(value);
    if (
      expression.type === "CallExpression" &&
      expression.callee.type === "Identifier"
    ) {
      const name = expression.callee.name;
      if (seen.has(name)) throw new Error(`Cyclic storage factory ${name}`);
      const factory = factories.get(name);
      return factory ? hasDeletedAt(factory, new Set([...seen, name])) : false;
    }
    if (expression.type !== "ObjectExpression") return false;
    return expression.properties.some((property) => {
      if (property.type === "SpreadElement")
        return hasDeletedAt(property.argument, seen);
      return property.key.type === "Identifier"
        ? property.key.name === "deletedAt"
        : property.key.type === "Literal" && property.key.value === "deletedAt";
    });
  };
  const varNames = new Set<string>();
  const sqlNameToVar = new Map<string, string>();
  const varToSqlName = new Map<string, string>();
  for (const declaration of declarations(schema)) {
    if (declaration.id.type !== "Identifier" || !declaration.init) continue;
    const init = expressionBody(declaration.init);
    if (
      init.type !== "CallExpression" ||
      init.callee.type !== "Identifier" ||
      init.callee.name !== "pgTable"
    )
      continue;
    const [name, columns] = init.arguments;
    if (
      name?.type !== "Literal" ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Oxc Literal is a primitive union; pgTable requires a string literal.
      typeof name.value !== "string" ||
      !columns ||
      columns.type === "SpreadElement"
    )
      throw new Error(`Cannot inspect table ${declaration.id.name}`);
    if (!hasDeletedAt(columns)) continue;
    varNames.add(declaration.id.name);
    sqlNameToVar.set(name.value, declaration.id.name);
    varToSqlName.set(declaration.id.name, name.value);
  }
  return { varNames, sqlNameToVar, varToSqlName };
}
