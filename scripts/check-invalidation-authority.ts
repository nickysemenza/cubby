/**
 * Operation descriptors are the single authority for what a mutation
 * invalidates. Enforcing that takes two checkers, and this is one of them.
 *
 * DIVISION OF LABOUR with the sibling
 * `apps/web/src/integrations/tanstack-query/operation-tags.unit.test.ts`:
 *
 *  - This script owns the repo-wide SOURCE sweep. It is the only one that sees
 *    an invalidation which never reaches an operation descriptor at all — an
 *    `invalidateTags` prop or registry row in a component file
 *    (`maintenance-card.tsx`, `auto-fix-registry.ts`, `backfill-registry.tsx`).
 *    The sibling reassembles the catalog by eagerly importing every
 *    `*.functions.ts` module, so none of those three is visible to it.
 *  - The test owns anything that requires EXECUTION. This script reads syntax;
 *    it cannot know what a policy function returns. A function-valued
 *    `invalidates` is counted here and deferred there, where it is replayed
 *    against sampled inputs.
 *
 * Three things have to stay true for the authority to keep meaning anything,
 * and none of them is expressible in the type system:
 *
 *  a. The legacy `queryKeys` / `invalidatesFor` / `invalidateQueryRoots` /
 *     `cancelQueryRoots` path stays deleted. It was a second, parallel
 *     invalidation system; the whole point of removing it was that two systems
 *     drift.
 *  b. `invalidateQueries` is called in exactly one module. Everywhere else goes
 *     through a tag, so there is one place to read to know what a write moves.
 *  c. Every tag in an invalidation position is LIVE — it prefix-matches a tag
 *     that some query declares. Matching is PREFIX-only, so `["product","merge"]`
 *     — longer than the `["product"]` its targets declare — matches nothing at
 *     all. Nine descriptors shipped in exactly that state; this is the rule that
 *     catches the tenth.
 *
 * Rule (c) checks that a tag CAN match something, never that it matches the
 * RIGHT something. Relevance is deliberately out of scope: the `ripple` table is
 * the human's answer to "which queries depend on this write", so a checker able
 * to re-derive that answer would replace the table rather than guard it. What is
 * left to guard is the mechanical half — a tag that can never match anything is
 * a silent no-op no matter whose judgement produced it.
 *
 * The sweep FAILS CLOSED. An `invalidates` / `invalidateTags` value this script
 * cannot read throws instead of contributing zero tags behind a reassuring OK
 * line, which is exactly how the nine dead tags shipped.
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
/**
 * The tag machinery itself, which PASSES tag lists around as ordinary values —
 * `descriptorMeta` copying a policy onto `meta`, the root MutationCache handing
 * already-resolved tags to `watchBatchesAndInvalidateTags`. Those are forwards
 * of a policy declared somewhere else, already counted at its declaration, so
 * the fail-closed check below does not apply to them.
 */
const INVALIDATION_ENGINE = new Set([
  cacheModule,
  resolve(webSource, "integrations/tanstack-query/operation-catalog.ts"),
  resolve(webSource, "integrations/tanstack-query/root-provider.tsx"),
]);

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
/**
 * `parent` exists for exactly one reason: `node.type === "Property"` is true for
 * an ObjectPattern (destructuring) property as well as an object literal's, and
 * the fail-closed check below must not fire on `{ invalidateTags = FALLBACK }`
 * or a shorthand `{ invalidateTags }` in a parameter list.
 */
const walk = (
  node: AstNode,
  visit: (node: AstNode, parent: AstNode | undefined) => void,
  parent?: AstNode,
): void => {
  visit(node, parent);
  for (const child of children(node)) walk(child, visit, node);
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
/** An inline policy: only the sibling test can say what it returns. */
const isPolicyFunction = (node: unknown): boolean =>
  isNode(node) &&
  (node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression");
/**
 * `entityRipple(<entity>)` — readable without executing it, because the loop
 * below already walks every value it can return over the whole manifest.
 */
const isEntityRippleCall = (node: unknown): boolean =>
  isNode(node) &&
  node.type === "CallExpression" &&
  isNode(node.callee) &&
  node.callee.type === "Identifier" &&
  node.callee.name === "entityRipple";
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
/**
 * Pre-seeded with `[entity]` for every manifest entity, which is not a loophole:
 * `descriptorMeta` (`operation-catalog.ts`) appends `[[entity]]` to `cacheTags`
 * at runtime for any `forEntity` query, so `entity.list` / `entity.detail`
 * really do answer to `["wish"]`, `["ledgerParty"]`, … even though no source
 * file spells those tags out. Without the pre-seed, every `entityRipple(e)` row
 * would read as dead.
 */
const declaredTags: string[][] = Object.keys(generatedEntityManifest).map(
  (entity) => [entity],
);
/** Function-valued policies: counted here, replayed in the sibling test. */
const dynamicPolicies: string[] = [];
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

  const isTest = /\.(unit|integration)\.test\.tsx?$/u.test(file);

  walk(parsed.program as unknown as AstNode, (node, parent) => {
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
      !isTest
    ) {
      violations.push(
        `${where(node)} calls \`invalidateQueries\` directly — go through \`invalidateOperationTags\` so every invalidation is a tag.`,
      );
    }
    // (c) collect both sides of the tag contract
    if (node.type === "Property" && propertyName(node) === "tags") {
      for (const tag of tagListLiteral(node.value) ?? []) declaredTags.push(tag);
    }

    // A DECLARATION position is an object-literal property or a JSX attribute.
    // A `Property` under an ObjectPattern is a destructuring binding — a
    // parameter name, not a policy — and a `TSPropertySignature` is a type
    // member; neither reaches this branch.
    const declaresInvalidation =
      (node.type === "Property" && parent?.type === "ObjectExpression") ||
      node.type === "JSXAttribute";
    if (!declaresInvalidation) return;
    const name =
      node.type === "JSXAttribute"
        ? isNode(node.name) && node.name.type === "JSXIdentifier"
          ? (node.name.name as string)
          : undefined
        : propertyName(node);
    if (name !== "invalidates" && name !== "invalidateTags") return;
    const value =
      node.type === "JSXAttribute" &&
      isNode(node.value) &&
      node.value.type === "JSXExpressionContainer"
        ? node.value.expression
        : node.value;

    const tags = tagListLiteral(value) ?? rippleReference(value);
    if (tags) {
      for (const tag of tags)
        invalidationTags.push({
          file: relative(root, file),
          line: lineAt(source, (node.start as number) ?? 0),
          tag,
        });
      return;
    }
    if (isEntityRippleCall(value)) return; // swept over the whole manifest below
    if (isPolicyFunction(value)) {
      if (!isTest) dynamicPolicies.push(where(node));
      return;
    }
    // A fixture may hand a policy any shape it likes, and the tag machinery
    // itself only forwards values; everywhere else, an unreadable declaration
    // is uncounted tags hiding behind an OK line, so it stops the sweep.
    if (isTest || INVALIDATION_ENGINE.has(resolve(file))) return;
    throw new Error(
      `${where(node)}: \`${name}\` is not readable by check-invalidation-authority (got a ${String((value as AstNode | undefined)?.type ?? "missing value")}). ` +
        "Write it as a literal tag list (`[[\"product\"]]`), a `ripple.<row>` reference, or a function — " +
        "a function is deferred to operation-tags.unit.test.ts, which replays it against a declared sample input.",
    );
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
  `OK: check-invalidation-authority passed (${invalidationTags.length} invalidation tags against ${declaredTags.length} declared; ${dynamicPolicies.length} dynamic ${dynamicPolicies.length === 1 ? "policy" : "policies"} deferred to operation-tags.unit.test.ts).`,
);
