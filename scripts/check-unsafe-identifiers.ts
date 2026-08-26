import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

export type IdentifierViolationKind =
  | "unsafe-helper-declaration"
  | "unsafe-helper-import"
  | "unsafe-helper-call"
  | "branded-assertion";

export type IdentifierViolation = Readonly<{
  file: string;
  kind: IdentifierViolationKind;
  message: string;
  start: number;
  end: number;
  line: number;
  column: number;
}>;

type AstNode = { type: string; [key: string]: unknown };

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const UNSAFE_HELPER = /^unsafe(?:[A-Z][A-Za-z0-9]*)?(?:Id|Shortcode)$/u;
const UNSAFE_ENTITY_HELPER = "unsafeIdForEntity";
const TESTING_MODULE = "@cubby/schemas/testing";
const BRANDED_TYPES = new Set([
  "UserId",
  "RecipeId",
  "ImageId",
  "IngredientId",
  "ProductId",
  "LocationId",
  "InventoryId",
  "CookbookId",
  "MealId",
  "LedgerPartyId",
  "ExpenseAttributionId",
  "LedgerTransferId",
  "MealRecipeId",
  "ProjectId",
  "TaskId",
  "ExpenseId",
  "FinancialAccountId",
  "FinancialTransactionId",
  "VendorId",
  "PurchaseId",
  "WishId",
  "CookbookShortcode",
  "ExpenseShortcode",
  "FinancialAccountShortcode",
  "FinancialTransactionShortcode",
  "ImageShortcode",
  "IngredientShortcode",
  "InventoryShortcode",
  "LedgerPartyShortcode",
  "LedgerTransferShortcode",
  "LocationShortcode",
  "MealShortcode",
  "ProductShortcode",
  "ProjectShortcode",
  "PurchaseShortcode",
  "RecipeShortcode",
  "TaskShortcode",
  "VendorShortcode",
  "WishShortcode",
]);

const isAstNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && "type" in value;

const nodeName = (node: AstNode | undefined): string | undefined => {
  if (!node) return undefined;
  if (node.type === "Identifier") return typeof node.name === "string" ? node.name : undefined;
  if (node.type === "PrivateIdentifier") {
    return typeof node.name === "string" ? node.name : undefined;
  }
  if (node.type === "TSQualifiedName") {
    return nodeName(isAstNode(node.right) ? node.right : undefined);
  }
  return undefined;
};

const literalString = (node: unknown): string | undefined =>
  isAstNode(node) && node.type === "Literal" && typeof node.value === "string"
    ? node.value
    : undefined;

const expressionNames = (node: AstNode | undefined): string[] => {
  if (!node) return [];
  if (node.type === "MemberExpression") {
    const property = isAstNode(node.property) ? node.property : undefined;
    const object = isAstNode(node.object) ? node.object : undefined;
    const propertyName = nodeName(property);
    return [...(propertyName ? [propertyName] : []), ...expressionNames(object)];
  }
  const name = nodeName(node);
  return name ? [name] : [];
};

const isUnsafeHelperName = (name: string | undefined): name is string =>
  name !== undefined && (UNSAFE_HELPER.test(name) || name === UNSAFE_ENTITY_HELPER);

const typeName = (node: AstNode | undefined): string | undefined => {
  if (!node) return undefined;
  if (node.type === "TSTypeReference") {
    return nodeName(isAstNode(node.typeName) ? node.typeName : undefined);
  }
  return nodeName(node);
};

const isBrandedType = (node: AstNode | undefined): boolean => {
  if (!node) return false;
  if (node.type === "TSTypeReference") {
    const name = typeName(node);
    if (
      name === "EntityId" ||
      name === "ShortcodeFor" ||
      name === "BrandForEntity" ||
      name === "TId" ||
      (name !== undefined && BRANDED_TYPES.has(name))
    ) {
      return true;
    }
  }
  if (node.type === "Identifier") return false;
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      if (value.some((child) => isAstNode(child) && isBrandedType(child))) return true;
    } else if (isAstNode(value) && isBrandedType(value)) {
      return true;
    }
  }
  return false;
};

const positionAt = (source: string, offset: number): { line: number; column: number } => {
  const prefix = source.slice(0, offset);
  const lineStart = prefix.lastIndexOf("\n") + 1;
  return {
    line: prefix.split("\n").length,
    column: offset - lineStart + 1,
  };
};

const rangeOf = (node: AstNode): { start: number; end: number } => ({
  start: typeof node.start === "number" ? node.start : 0,
  end: typeof node.end === "number" ? node.end : 0,
});

const scanProgram = (file: string, source: string, program: AstNode): IdentifierViolation[] => {
  const violations: IdentifierViolation[] = [];
  const unsafeAliases = new Set<string>();
  const seen = new Set<string>();

  const add = (kind: IdentifierViolationKind, node: AstNode, message: string): void => {
    const { start, end } = rangeOf(node);
    const key = `${kind}:${start}:${end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { line, column } = positionAt(source, start);
    violations.push({ file, kind, message, start, end, line, column });
  };

  const visit = (node: AstNode): void => {
    if (node.type === "ImportDeclaration") {
      if (literalString(node.source) === TESTING_MODULE && !isTestPath(file)) {
        add(
          "unsafe-helper-import",
          node,
          `imports test-only identifier helpers from ${TESTING_MODULE}`,
        );
      }
      const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
      for (const value of specifiers) {
        if (!isAstNode(value)) continue;
        const imported = isAstNode(value.imported) ? nodeName(value.imported) : undefined;
        const local = isAstNode(value.local) ? nodeName(value.local) : undefined;
        const unsafeName = isUnsafeHelperName(imported)
          ? imported
          : isUnsafeHelperName(local)
            ? local
            : undefined;
        if (unsafeName !== undefined) {
          if (local) unsafeAliases.add(local);
          add(
            "unsafe-helper-import",
            value,
            `imports forbidden unsafe identifier helper ${unsafeName}`,
          );
        }
      }
    }

    if (
      node.type === "FunctionDeclaration" ||
      node.type === "ClassDeclaration" ||
      node.type === "VariableDeclarator"
    ) {
      const declared = isAstNode(node.id) ? nodeName(node.id) : undefined;
      if (isUnsafeHelperName(declared)) {
        add("unsafe-helper-declaration", node, `declares forbidden unsafe identifier helper ${declared}`);
      }
    }

    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const callee = isAstNode(node.callee) ? node.callee : undefined;
      const called = expressionNames(callee);
      const forbidden = called.find(
        (name) => isUnsafeHelperName(name) || unsafeAliases.has(name),
      );
      if (forbidden !== undefined) {
        add("unsafe-helper-call", node, `calls forbidden unsafe identifier helper ${forbidden}`);
      }
    }

    if (node.type === "TSAsExpression" || node.type === "TSTypeAssertion") {
      const asserted = isAstNode(node.typeAnnotation) ? node.typeAnnotation : undefined;
      if (isBrandedType(asserted)) {
        add("branded-assertion", node, "asserts a value as a branded identifier type");
      }
    }

    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isAstNode(child)) visit(child);
        }
      } else if (isAstNode(value)) {
        visit(value);
      }
    }
  };

  visit(program);
  return violations.sort((left, right) => left.start - right.start || left.kind.localeCompare(right.kind));
};

/** Scan one TypeScript source string with OXC's TypeScript/TSX parser. */
export const scanSource = (file: string, source: string): IdentifierViolation[] => {
  const parsed = parseSync(file, source, {
    lang: extname(file) === ".tsx" ? "tsx" : "ts",
    range: true,
  });
  const firstError = parsed.errors.at(0);
  if (firstError !== undefined) {
    throw new Error(`${file}: ${firstError.message}`);
  }
  return scanProgram(file, source, parsed.program as unknown as AstNode);
};

export type ScanOptions = Readonly<{ includeTests?: boolean }>;

const isTestPath = (path: string): boolean =>
  /(?:^|[\\/])(?:tests?|__fixtures__|test-support|tooling)(?:[\\/]|$)/u.test(path) ||
  /\.(?:test|spec|fixtures)\.[cm]?[jt]sx?$/u.test(path);

const sourceFilesUnder = (path: string, options: ScanOptions): string[] => {
  const stat = statSync(path);
  if (stat.isFile()) {
    return SOURCE_EXTENSIONS.has(extname(path)) &&
        !path.endsWith(".d.ts") &&
        (options.includeTests === true || !isTestPath(path))
      ? [path]
      : [];
  }
  if (!stat.isDirectory() || IGNORED_DIRECTORIES.has(basename(path))) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(path, entry.name);
    return entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)
      ? []
      : sourceFilesUnder(child, options);
  });
};

/** Scan explicit files/directories, preserving a stable path order. */
export const scanPaths = (
  paths: readonly string[],
  options: ScanOptions = {},
): IdentifierViolation[] =>
  paths
    .flatMap((path) => sourceFilesUnder(resolve(path), options))
    .sort()
    .flatMap((file) => scanSource(file, readFileSync(file, "utf8")));

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const main = (): void => {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("Usage: node scripts/check-unsafe-identifiers.ts [file-or-directory ...]");
    return;
  }
  const paths = args.filter((arg) => !arg.startsWith("--"));
  const violations = scanPaths(paths.length > 0 ? paths : [root], {
    includeTests: args.includes("--include-tests"),
  });
  if (violations.length === 0) return;
  for (const violation of violations) {
    const displayPath = relative(root, violation.file) || violation.file;
    console.error(`${displayPath}:${violation.line}:${violation.column} ${violation.message}`);
  }
  console.error(`Found ${violations.length} unsafe identifier violation(s).`);
  process.exitCode = 1;
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
