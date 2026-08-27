/**
 * Operation descriptors are the single authority for what a mutation
 * invalidates. Three things have to stay true for that to keep meaning
 * anything, and none of them is expressible in the type system:
 *
 *  a. The legacy `queryKeys` / `invalidatesFor` / `invalidateQueryRoots` /
 *     `cancelQueryRoots` path stays deleted. It was a second, parallel
 *     invalidation system; the whole point of removing it was that two systems
 *     drift.
 *  b. `invalidateQueries` is called in exactly one module. Everywhere else goes
 *     through a tag, so there is one place to read to know what a write moves.
 *  c. Every tag in an invalidation position is declared by some query. Tag
 *     matching is PREFIX-only, so `["product","merge"]` — longer than the
 *     `["product"]` its targets declare — silently matches nothing. Nine
 *     descriptors shipped in exactly that state; this is the rule that catches
 *     the tenth.
 *
 * Checked over the AST rather than the source text, so the comments that
 * explain the migration can go on naming what it replaced.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "oxc-parser";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webSource = resolve(root, "apps/web/src");
const cacheModule = resolve(
  webSource,
  "integrations/tanstack-query/operation-cache.ts",
);

const { ripple, entityRipple } = (await import(
  resolve(webSource, "integrations/tanstack-query/cache-tags.ts")
)) as {
  ripple: Record<string, readonly (readonly string[])[]>;
  entityRipple: (entity: string) => readonly (readonly string[])[];
};
const { generatedEntityManifest } = (await import(
  resolve(root, "packages/schemas/src/generated/entity-manifest-data.gen.ts")
)) as { generatedEntityManifest: Record<string, unknown> };

const RETIRED = new Set([
  "invalidateQueryRoots",
  "cancelQueryRoots",
  "invalidatesFor",
  "normalizeQueryRoot",
]);
const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", "coverage"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);

type AstNode = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && "type" in value;
const children = (node: AstNode): AstNode[] =>
  Object.values(node).flatMap((value) =>
    Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : [],
  );
const walk = (node: AstNode, visit: (node: AstNode) => void): void => {
  visit(node);
  for (const child of children(node)) walk(child, visit);
};
const lineAt = (source: string, offset: number) =>
  source.slice(0, offset).split("\n").length;

const sourceFiles = (path: string): string[] => {
  const stat = statSync(path);
  if (stat.isFile())
    return SOURCE_EXTENSIONS.has(extname(path)) && !path.endsWith(".d.ts")
      ? [path]
      : [];
  if (IGNORED_DIRECTORIES.has(basename(path))) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    sourceFiles(resolve(path, entry.name)),
  );
};

/** `["a","b"]` as a tag, or undefined when the element is not a literal tag. */
const tagLiteral = (node: unknown): string[] | undefined => {
  if (!isNode(node) || node.type !== "ArrayExpression") return undefined;
  const parts = (node.elements as unknown[]).map((element) =>
    isNode(element) &&
    element.type === "Literal" &&
    typeof element.value === "string"
      ? element.value
      : undefined,
  );
  return parts.every((part): part is string => part !== undefined) && parts.length
    ? parts
    : undefined;
};
const tagListLiteral = (node: unknown): string[][] | undefined => {
  if (!isNode(node) || node.type !== "ArrayExpression") return undefined;
  const tags = (node.elements as unknown[]).map(tagLiteral);
  return tags.every((tag): tag is string[] => tag !== undefined)
    ? tags
    : undefined;
};
/** `ripple.productMerge` — resolved against the real table, not re-parsed. */
const rippleReference = (node: unknown): string[][] | undefined => {
  if (!isNode(node) || node.type !== "MemberExpression") return undefined;
  const object = node.object as AstNode | undefined;
  const property = node.property as AstNode | undefined;
  if (object?.type !== "Identifier" || object.name !== "ripple") return undefined;
  const name =
    property?.type === "Identifier"
      ? (property.name as string)
      : property?.type === "Literal" && typeof property.value === "string"
        ? property.value
        : undefined;
  const row = name === undefined ? undefined : ripple[name];
  return row ? row.map((tag) => [...tag]) : undefined;
};
const propertyName = (node: AstNode): string | undefined => {
  const key = node.key as AstNode | undefined;
  if (node.computed === true) return undefined;
  return key?.type === "Identifier"
    ? (key.name as string)
    : key?.type === "Literal" && typeof key.value === "string"
      ? key.value
      : undefined;
};

const violations: string[] = [];
const declaredTags: string[][] = Object.keys(generatedEntityManifest).map(
  (entity) => [entity],
);
const invalidationTags: Array<{ file: string; line: number; tag: string[] }> =
  [];

for (const file of sourceFiles(webSource).sort()) {
  const source = readFileSync(file, "utf8");
  const parsed = parseSync(file, source, {
    lang: extname(file) === ".tsx" ? "tsx" : "ts",
    range: true,
  });
  const error = parsed.errors.at(0);
  if (error) throw new Error(`${file}: ${error.message}`);
  const where = (node: AstNode) =>
    `${relative(root, file)}:${lineAt(source, (node.start as number) ?? 0)}`;

  walk(parsed.program as unknown as AstNode, (node) => {
    // (a) the retired key path
    if (node.type === "Identifier" && RETIRED.has(node.name as string)) {
      violations.push(
        `${where(node)} references \`${node.name}\` — the legacy query-key invalidation path is gone; declare tags on the operation descriptor instead.`,
      );
    }
    if (
      node.type === "MemberExpression" &&
      isNode(node.object) &&
      node.object.type === "Identifier" &&
      node.object.name === "queryKeys"
    ) {
      violations.push(
        `${where(node)} references \`queryKeys\` — deleted; a query's identity is its operation descriptor.`,
      );
    }
    // (b) one module owns invalidateQueries
    if (
      node.type === "CallExpression" &&
      isNode(node.callee) &&
      node.callee.type === "MemberExpression" &&
      isNode(node.callee.property) &&
      node.callee.property.type === "Identifier" &&
      node.callee.property.name === "invalidateQueries" &&
      resolve(file) !== cacheModule &&
      // A test may drive a bare QueryClient to assert React Query's own
      // semantics; that is not an app invalidation policy.
      !/\.(unit|integration)\.test\.tsx?$/u.test(file)
    ) {
      violations.push(
        `${where(node)} calls \`invalidateQueries\` directly — go through \`invalidateOperationTags\` so every invalidation is a tag.`,
      );
    }
    // (c) collect both sides of the tag contract
    if (node.type !== "Property") return;
    const name = propertyName(node);
    if (name === "tags") {
      for (const tag of tagListLiteral(node.value) ?? []) declaredTags.push(tag);
    }
    if (name === "invalidates" || name === "invalidateTags") {
      const tags = tagListLiteral(node.value) ?? rippleReference(node.value);
      for (const tag of tags ?? [])
        invalidationTags.push({
          file: relative(root, file),
          line: lineAt(source, (node.start as number) ?? 0),
          tag,
        });
    }
  });
}

// `entityRipple` is the one dynamic policy; walk what it can actually return.
for (const entity of Object.keys(generatedEntityManifest))
  for (const tag of entityRipple(entity))
    invalidationTags.push({
      file: "apps/web/src/integrations/tanstack-query/cache-tags.ts",
      line: 0,
      tag: [...tag],
    });

const isPrefixOf = (tag: readonly string[], candidate: readonly string[]) =>
  tag.length <= candidate.length &&
  tag.every((part, index) => candidate[index] === part);

for (const { file, line, tag } of invalidationTags) {
  if (declaredTags.some((candidate) => isPrefixOf(tag, candidate))) continue;
  violations.push(
    `${file}${line ? `:${line}` : ""} invalidates [${tag.join(",")}], which no query declares — matching is prefix-only, so this is a silent no-op.`,
  );
}

if (violations.length > 0) {
  console.error(
    `\nFAIL: ${violations.length} invalidation-authority violation(s).\n`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  console.error("");
  process.exit(1);
}

console.log(
  `OK: check-invalidation-authority passed (${invalidationTags.length} invalidation tags against ${declaredTags.length} declared).`,
);
