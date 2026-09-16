import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Port of the deleted `scripts/check-unsafe-identifiers.ts` gate.
 *
 * `unsafe-helper-declaration` / `unsafe-helper-import` / `unsafe-helper-call` are
 * exact ports: they are purely syntactic (name/import-specifier matching), so a
 * single-file oxlint rule loses nothing versus the old whole-tree script.
 *
 * `branded-assertion` DOES lose coverage: the deleted script walked import/re-export
 * chains across files to resolve whether an asserted-to type was ultimately branded
 * (`z.<schema>().brand(...)`). A single oxlint rule invocation only sees one file, so
 * this port resolves types and values declared in THIS file only. An assertion to a
 * type/alias imported from elsewhere is not flagged even if that type is branded at
 * its declaration site. This is an accepted, documented loss (operator decision, see
 * docs/agents/validation.md) — `anti-slop/require-safety-comment-for-type-assertion`
 * still requires a SAFETY comment on every non-const assertion regardless.
 */

const UNSAFE_HELPER = /^unsafe(?:[A-Z][A-Za-z0-9]*)?(?:Id|Shortcode)$/u;
const TESTING_MODULE = "@cubby/schemas/testing";

type RuntimeFunction =
  | ESTree.ArrowFunctionExpression
  | ESTree.FunctionDeclaration
  | ESTree.FunctionExpression;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression"
  );
}

function isStringLiteral(
  node: ESTree.Expression,
): node is ESTree.StringLiteral {
  return node.type === "Literal" && typeof node.value === "string";
}

function isUnsafeName(name: string | null): name is string {
  return (
    name !== null && (UNSAFE_HELPER.test(name) || name === "unsafeIdForEntity")
  );
}

function staticPropertyKeyName(key: ESTree.PropertyKey): string | null {
  if (key.type === "Identifier") return key.name;
  return key.type !== "PrivateIdentifier" && isStringLiteral(key)
    ? key.value
    : null;
}

function staticMemberPropertyName(
  member: ESTree.MemberExpression,
): string | null {
  if (member.computed)
    return isStringLiteral(member.property) ? member.property.value : null;
  return member.property.type === "Identifier" ? member.property.name : null;
}

/** Identifier/member-access chain names, innermost property first (e.g. `a.b.c` -> ["c","b","a"]). */
function memberChainNames(expression: ESTree.Expression): string[] {
  if (expression.type === "MemberExpression") {
    const name = staticMemberPropertyName(expression);
    return [
      ...(name !== null ? [name] : []),
      ...memberChainNames(expression.object),
    ];
  }
  return expression.type === "Identifier" ? [expression.name] : [];
}

function typeReferenceNameParts(name: ESTree.TSTypeName): string[] {
  if (name.type === "TSQualifiedName")
    return [...typeReferenceNameParts(name.left), name.right.name];
  return name.type === "Identifier" ? [name.name] : [];
}

function typeQueryExprNameParts(name: ESTree.TSTypeQueryExprName): string[] {
  return name.type === "TSImportType" ? [] : typeReferenceNameParts(name);
}

/** One string-constant hop: `x = "literal"` or `x = otherConstant`. */
function constantStringValue(
  expression: ESTree.Expression | null,
  constants: ReadonlyMap<string, string>,
): string | null {
  if (expression === null) return null;
  if (isStringLiteral(expression)) return expression.value;
  return expression.type === "Identifier"
    ? (constants.get(expression.name) ?? null)
    : null;
}

function expressionContainsBrandCall(
  expression: ESTree.Expression,
  values: ReadonlyMap<string, ESTree.Expression>,
  visited: ReadonlySet<string>,
): boolean {
  if (expression.type === "CallExpression")
    return expressionContainsBrandCall(expression.callee, values, visited);
  if (expression.type === "MemberExpression") {
    if (staticMemberPropertyName(expression) === "brand") return true;
    return expressionContainsBrandCall(expression.object, values, visited);
  }
  if (expression.type === "Identifier") {
    if (visited.has(expression.name)) return false;
    const bound = values.get(expression.name);
    return (
      bound !== undefined &&
      expressionContainsBrandCall(
        bound,
        values,
        new Set([...visited, expression.name]),
      )
    );
  }
  return false;
}

type TypeDeclaration =
  | ESTree.TSInterfaceDeclaration
  | ESTree.TSTypeAliasDeclaration;

/** Same-file symbol tables the branded-assertion walk resolves against. */
type BrandCatalog = Readonly<{
  types: ReadonlyMap<string, TypeDeclaration>;
  values: ReadonlyMap<string, ESTree.Expression>;
}>;

type BrandScope = Readonly<{
  brands: ReadonlySet<string>;
  schemas: ReadonlySet<string>;
}>;

function isBrandedSchemaTypeArgument(
  type: ESTree.TSType,
  catalog: BrandCatalog,
  schemas: ReadonlySet<string>,
): boolean {
  if (type.type === "TSTypeQuery") {
    const parts = typeQueryExprNameParts(type.exprName);
    const [name] = parts;
    if (name === undefined || parts.length !== 1) return false;
    const bound = catalog.values.get(name);
    return (
      bound !== undefined &&
      expressionContainsBrandCall(bound, catalog.values, new Set([name]))
    );
  }
  if (type.type === "TSTypeReference") {
    const parts = typeReferenceNameParts(type.typeName);
    return (
      parts.length === 1 && parts[0] !== undefined && schemas.has(parts[0])
    );
  }
  return false;
}

const typeMemo = new WeakMap<BrandCatalog, Map<string, boolean>>();

function isBrandedLocalType(
  name: string,
  catalog: BrandCatalog,
  resolving: ReadonlySet<string>,
): boolean {
  let memo = typeMemo.get(catalog);
  if (memo === undefined) {
    memo = new Map();
    typeMemo.set(catalog, memo);
  }
  const cached = memo.get(name);
  if (cached !== undefined) return cached;
  if (resolving.has(name)) return false;
  const declaration = catalog.types.get(name);
  if (declaration === undefined) return false;
  const nextResolving = new Set([...resolving, name]);
  const result =
    declaration.type === "TSTypeAliasDeclaration"
      ? isBrandedType(
          declaration.typeAnnotation,
          catalog,
          new Set(),
          new Set(),
          nextResolving,
        )
      : isBrandedInterface(declaration, catalog, nextResolving);
  memo.set(name, result);
  return result;
}

function isBrandedInterface(
  declaration: ESTree.TSInterfaceDeclaration,
  catalog: BrandCatalog,
  resolving: ReadonlySet<string>,
): boolean {
  const heritageBranded = declaration.extends.some((heritage) => {
    if (heritage.expression.type !== "Identifier") return false;
    return isBrandedLocalType(heritage.expression.name, catalog, resolving);
  });
  if (heritageBranded) return true;
  return isBrandedSignatures(declaration.body.body, catalog, resolving);
}

/** Walk property/index signatures (interface body or type-literal members) for a branded field. */
function isBrandedSignatures(
  signatures: readonly ESTree.TSSignature[],
  catalog: BrandCatalog,
  resolving: ReadonlySet<string>,
): boolean {
  return signatures.some((signature) => {
    if (signature.type === "TSPropertySignature")
      return (
        signature.typeAnnotation !== null &&
        isBrandedType(
          signature.typeAnnotation.typeAnnotation,
          catalog,
          new Set(),
          new Set(),
          resolving,
        )
      );
    if (signature.type === "TSIndexSignature")
      return isBrandedType(
        signature.typeAnnotation.typeAnnotation,
        catalog,
        new Set(),
        new Set(),
        resolving,
      );
    return false;
  });
}

/**
 * Structural walk of a type node for branded-ness: literal `$brand`, a function-scoped
 * generic/schema binding, `z.infer`/`z.output` of a local `.brand()` schema, or a
 * same-file type alias/interface that itself resolves branded. Mirrors
 * `check-unsafe-identifiers.ts`'s `Provenance.brandedType`, minus cross-file lookups.
 */
function isBrandedType(
  type: ESTree.TSType,
  catalog: BrandCatalog,
  brands: ReadonlySet<string>,
  schemas: ReadonlySet<string>,
  resolving: ReadonlySet<string>,
): boolean {
  switch (type.type) {
    case "TSTypeOperator":
      return (
        type.operator !== "keyof" &&
        isBrandedType(type.typeAnnotation, catalog, brands, schemas, resolving)
      );
    case "TSParenthesizedType":
      return isBrandedType(
        type.typeAnnotation,
        catalog,
        brands,
        schemas,
        resolving,
      );
    case "TSArrayType":
      return isBrandedType(
        type.elementType,
        catalog,
        brands,
        schemas,
        resolving,
      );
    case "TSIndexedAccessType":
      return (
        isBrandedType(type.objectType, catalog, brands, schemas, resolving) ||
        isBrandedType(type.indexType, catalog, brands, schemas, resolving)
      );
    case "TSUnionType":
    case "TSIntersectionType":
      return type.types.some((member) =>
        isBrandedType(member, catalog, brands, schemas, resolving),
      );
    case "TSTypeReference":
      return isBrandedTypeReference(type, catalog, brands, schemas, resolving);
    case "TSTypeLiteral":
      return isBrandedSignatures(type.members, catalog, resolving);
    default:
      return false;
  }
}

function isBrandedTypeReference(
  type: ESTree.TSTypeReference,
  catalog: BrandCatalog,
  brands: ReadonlySet<string>,
  schemas: ReadonlySet<string>,
  resolving: ReadonlySet<string>,
): boolean {
  const parts = typeReferenceNameParts(type.typeName);
  const tail = parts.at(-1) ?? null;
  if (tail === "$brand") return true;
  if (tail !== null && (brands.has(tail) || schemas.has(tail))) return true;
  const args = type.typeArguments?.params ?? [];
  if (
    tail !== null &&
    (tail === "infer" || tail === "output") &&
    parts[0] === "z"
  )
    return args.some((arg) =>
      isBrandedSchemaTypeArgument(arg, catalog, schemas),
    );
  if (
    tail !== null &&
    parts.length === 1 &&
    isBrandedLocalType(tail, catalog, resolving)
  )
    return true;
  return args.some((arg) =>
    isBrandedType(arg, catalog, brands, schemas, resolving),
  );
}

function parameterTypeNode(
  parameter: ESTree.ParamPattern,
): ESTree.TSType | null {
  if (parameter.type === "TSParameterProperty")
    return parameterTypeNode(parameter.parameter);
  if (parameter.type === "RestElement")
    return parameter.typeAnnotation?.typeAnnotation ?? null;
  if (parameter.type === "AssignmentPattern")
    return (
      parameter.typeAnnotation?.typeAnnotation ??
      parameterTypeNode(parameter.left)
    );
  return "typeAnnotation" in parameter
    ? (parameter.typeAnnotation?.typeAnnotation ?? null)
    : null;
}

/** Find `schema: z.ZodType<T>` / `z.ZodSchema<T>` params and record `T` as a schema-output name. */
function collectSchemaParams(type: ESTree.TSType, schemas: Set<string>): void {
  if (type.type === "TSTypeReference") {
    const name = typeReferenceNameParts(type.typeName).at(-1);
    const args = type.typeArguments?.params ?? [];
    if (name === "ZodType" || name === "ZodSchema") {
      const [output] = args;
      const outputName =
        output?.type === "TSTypeReference"
          ? typeReferenceNameParts(output.typeName).at(-1)
          : undefined;
      if (outputName !== undefined) schemas.add(outputName);
    }
    for (const arg of args) collectSchemaParams(arg, schemas);
    return;
  }
  if (type.type === "TSArrayType") {
    collectSchemaParams(type.elementType, schemas);
    return;
  }
  if (type.type === "TSParenthesizedType" || type.type === "TSTypeOperator") {
    collectSchemaParams(type.typeAnnotation, schemas);
    return;
  }
  if (type.type === "TSUnionType" || type.type === "TSIntersectionType") {
    for (const member of type.types) collectSchemaParams(member, schemas);
  }
}

function functionScopeBrandsAndSchemas(
  fn: RuntimeFunction,
  catalog: BrandCatalog,
): BrandScope {
  const brands = new Set<string>();
  const schemas = new Set<string>();
  for (const parameter of fn.typeParameters?.params ?? []) {
    if (
      parameter.constraint !== null &&
      isBrandedType(
        parameter.constraint,
        catalog,
        new Set(),
        new Set(),
        new Set(),
      )
    )
      brands.add(parameter.name.name);
  }
  for (const parameter of fn.params) {
    const annotation = parameterTypeNode(parameter);
    if (annotation !== null) collectSchemaParams(annotation, schemas);
  }
  return { brands, schemas };
}

function enclosingFunctionScope(
  node: ESTree.Node,
  catalog: BrandCatalog,
): BrandScope {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isRuntimeFunction(current))
      return functionScopeBrandsAndSchemas(current, catalog);
    current = current.parent;
  }
  return { brands: new Set(), schemas: new Set() };
}

/** Port of `declarations()` in `schema-storage.ts`: top-level statements, unwrapping `export`. */
function topLevelStatements(program: ESTree.Program): ESTree.Statement[] {
  return program.body.flatMap((statement) =>
    statement.type === "ExportNamedDeclaration" &&
    statement.declaration !== null
      ? [statement.declaration]
      : [statement],
  );
}

function collectCatalog(program: ESTree.Program): BrandCatalog {
  const types = new Map<string, TypeDeclaration>();
  const values = new Map<string, ESTree.Expression>();
  for (const statement of topLevelStatements(program)) {
    if (
      statement.type === "TSTypeAliasDeclaration" ||
      statement.type === "TSInterfaceDeclaration"
    ) {
      types.set(statement.id.name, statement);
      continue;
    }
    if (statement.type === "VariableDeclaration") {
      for (const declarator of statement.declarations) {
        if (declarator.id.type === "Identifier" && declarator.init !== null)
          values.set(declarator.id.name, declarator.init);
      }
    }
  }
  return { types, values };
}

function checkBrandedAssertion(
  node: ESTree.TSAsExpression | ESTree.TSTypeAssertion,
  catalog: BrandCatalog,
  report: () => void,
): void {
  const { brands, schemas } = enclosingFunctionScope(node, catalog);
  if (isBrandedType(node.typeAnnotation, catalog, brands, schemas, new Set()))
    report();
}

/** Cubby's forbidden-identifier gate: unsafe test-only helpers and branded-value assertions. */
export const noUnsafeIdentifiersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unsafe test-only identifier helpers in production code and disallow asserting a value directly into a branded identifier type.",
    },
    messages: {
      unsafeHelperDeclaration:
        "`{{name}}` declares a forbidden unsafe identifier helper. These exist only for test fixtures; production code must construct branded identifiers through validated schemas.",
      unsafeHelperImport:
        "This import/export/require reaches a test-only identifier helper ({{detail}}). Test-only identifier helpers may only be used from test paths.",
      unsafeHelperCall:
        "`{{name}}` calls a forbidden unsafe identifier helper. Construct the branded identifier through its validated schema instead.",
      brandedAssertion:
        "This assertion asserts a value directly into a branded identifier type. Parse it through the branded schema instead of asserting past validation.",
    },
  },
  createOnce(context) {
    const aliases = new Set<string>();
    const constants = new Map<string, string>();
    let catalog: BrandCatalog = { types: new Map(), values: new Map() };

    const reportDeclaration = (node: ESTree.Node, name: string) => {
      context.report({
        node,
        messageId: "unsafeHelperDeclaration",
        data: { name },
      });
    };
    const reportImport = (node: ESTree.Node, detail: string) => {
      context.report({
        node,
        messageId: "unsafeHelperImport",
        data: { detail },
      });
    };
    const reportCall = (node: ESTree.Node, name: string) => {
      context.report({ node, messageId: "unsafeHelperCall", data: { name } });
    };
    const checkDeclarationName = (node: ESTree.Node, name: string | null) => {
      if (isUnsafeName(name)) reportDeclaration(node, name);
    };

    return {
      Program(node) {
        catalog = collectCatalog(node);
      },

      FunctionDeclaration(node) {
        checkDeclarationName(node, node.id?.name ?? null);
      },
      ClassDeclaration(node) {
        checkDeclarationName(node, node.id?.name ?? null);
      },
      VariableDeclarator(node) {
        if (node.id.type === "Identifier")
          checkDeclarationName(node, node.id.name);
        if (node.init === null) return;
        const initChain = memberChainNames(node.init);
        const referencesUnsafe = initChain.some(
          (name) => isUnsafeName(name) || aliases.has(name),
        );
        if (node.id.type === "Identifier") {
          if (referencesUnsafe) aliases.add(node.id.name);
          const literal = constantStringValue(node.init, constants);
          if (literal !== null) constants.set(node.id.name, literal);
        }
      },
      Property(node) {
        const name = staticPropertyKeyName(node.key);
        checkDeclarationName(node, name);
        if (
          isUnsafeName(name) &&
          node.parent.type === "ObjectPattern" &&
          node.value.type === "Identifier"
        ) {
          aliases.add(node.value.name);
        }
      },
      MethodDefinition(node) {
        checkDeclarationName(node, staticPropertyKeyName(node.key));
      },
      PropertyDefinition(node) {
        checkDeclarationName(node, staticPropertyKeyName(node.key));
      },

      ImportDeclaration(node) {
        if (node.source.value === TESTING_MODULE)
          reportImport(
            node,
            `imports test-only identifier helpers from ${TESTING_MODULE}`,
          );
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const importedName =
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : null;
            const localName = specifier.local.name;
            const forbidden = isUnsafeName(importedName)
              ? importedName
              : isUnsafeName(localName)
                ? localName
                : null;
            if (forbidden !== null) {
              reportImport(
                specifier,
                `imports forbidden unsafe identifier helper ${forbidden}`,
              );
              aliases.add(localName);
            }
            continue;
          }
          if (isUnsafeName(specifier.local.name)) {
            reportImport(
              specifier,
              `imports forbidden unsafe identifier helper ${specifier.local.name}`,
            );
            aliases.add(specifier.local.name);
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null && node.source.value === TESTING_MODULE)
          reportImport(
            node,
            `re-exports test-only identifier helpers from ${TESTING_MODULE}`,
          );
        for (const specifier of node.specifiers) {
          const localName =
            specifier.local.type === "Identifier" ? specifier.local.name : null;
          const exportedName =
            specifier.exported.type === "Identifier"
              ? specifier.exported.name
              : null;
          const forbidden = isUnsafeName(localName)
            ? localName
            : isUnsafeName(exportedName)
              ? exportedName
              : null;
          if (forbidden !== null)
            reportImport(
              specifier,
              `imports or re-exports forbidden unsafe identifier helper ${forbidden}`,
            );
        }
      },
      ExportAllDeclaration(node) {
        if (node.source.value === TESTING_MODULE)
          reportImport(
            node,
            `re-exports test-only identifier helpers from ${TESTING_MODULE}`,
          );
      },
      ImportExpression(node) {
        if (node.source.type !== "Literal" && node.source.type !== "Identifier")
          return;
        const source = constantStringValue(node.source, constants);
        if (source === TESTING_MODULE)
          reportImport(
            node,
            `dynamically imports test-only identifier helpers from ${TESTING_MODULE}`,
          );
      },

      CallExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "require" &&
          node.arguments.length === 1
        ) {
          const [argument] = node.arguments;
          const source =
            argument !== undefined && argument.type !== "SpreadElement"
              ? constantStringValue(argument, constants)
              : null;
          if (source === TESTING_MODULE) {
            reportImport(
              node,
              `requires test-only identifier helpers from ${TESTING_MODULE}`,
            );
            return;
          }
        }
        const names = memberChainNames(node.callee);
        const forbidden = names.find(
          (name) => isUnsafeName(name) || aliases.has(name),
        );
        if (forbidden !== undefined) reportCall(node, forbidden);
      },
      NewExpression(node) {
        const names = memberChainNames(node.callee);
        const forbidden = names.find(
          (name) => isUnsafeName(name) || aliases.has(name),
        );
        if (forbidden !== undefined) reportCall(node, forbidden);
      },

      TSAsExpression(node) {
        checkBrandedAssertion(node, catalog, () =>
          context.report({ node, messageId: "brandedAssertion" }),
        );
      },
      TSTypeAssertion(node) {
        checkBrandedAssertion(node, catalog, () =>
          context.report({ node, messageId: "brandedAssertion" }),
        );
      },
    };
  },
});
