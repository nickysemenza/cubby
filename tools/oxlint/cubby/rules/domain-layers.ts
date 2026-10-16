import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Layer direction for the domain-first layout (docs/adr/0019-domain-first-server-layout.md).
 *
 * Server: a role is the path segment after `domains/<x>/` or `generic/<x>/`
 * (`repo`, `service`, `operations`, as a folder or a `<role>.ts` file). The
 * entry points `http/`, `mcp/`, and `workflows/` import like `operations` but
 * are imported as platform infrastructure. Roles
 * import only the same or a lower role (`operations` → `service` → `repo` →
 * `db`), in any domain; `ai/repo/` ranks as `repo`. `repo` never imports
 * `ai/` except `ai/repo/` and `ai/policy/`, and `ai/policy/` value-imports
 * only itself and packages, so a repo never reaches model code. A `service`
 * value-imports nothing from `db/` but `db/freshness/` and never imports a
 * schema or `db/helpers`; other platform code and `generic/*` never import a
 * domain's `service` or `operations`.
 *
 * Client: `ui/` imports neither `features/` nor `entity/`; `entity/` does not
 * import `features/`.
 *
 * Tests, fixtures, and live evals are exempt.
 */

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const SRC = "apps/web/src/";
const SERVER = `${SRC}server/`;
const RANK = { repo: 1, service: 2, operations: 3 } as const;
type Role = keyof typeof RANK;
const ROLE_PATH =
  /^apps\/web\/src\/server\/(domains|generic)\/([^/]+)\/(repo|service|operations)(?:[./]|$)/u;
const EXEMPT = /\.(?:test|spec)\.tsx?$|\.fixtures\.tsx?$|\.live-eval\.ts$/u;

const ENTRY_PATH = /^apps\/web\/src\/server\/(?:http|mcp|workflows)(?:[./]|$)/u;

const isRole = (value: string | undefined): value is Role =>
  value === "repo" || value === "service" || value === "operations";

const AI_REPO_PATH = /^apps\/web\/src\/server\/ai\/repo(?:[./]|$)/u;
const AI_POLICY_PATH = /^apps\/web\/src\/server\/ai\/policy(?:[./]|$)/u;

function roleOf(path: string): { area: string; role: Role } | undefined {
  if (AI_REPO_PATH.test(path)) return { area: "ai", role: "repo" };
  const match = ROLE_PATH.exec(path);
  const role = match?.[3];
  if (!match || !isRole(role)) return;
  return { area: match[1]!, role };
}

const isDb = (path: string) =>
  /^apps\/web\/src\/server\/db(?:[./]|$)/u.test(path);
const isDbInternals = (path: string) =>
  /^apps\/web\/src\/server\/db\/(?:schema|helpers|[^/]*schema[^/]*$)(?:[./]|$)/u.test(
    path,
  );
const isDbFreshness = (path: string) =>
  /^apps\/web\/src\/server\/db\/freshness(?:[./]|$)/u.test(path);
const isAi = (path: string) =>
  /^apps\/web\/src\/server\/ai(?:[./]|$)/u.test(path) &&
  !AI_REPO_PATH.test(path) &&
  !AI_POLICY_PATH.test(path);
const isDomainUpper = (path: string) => {
  const role = roleOf(path);
  return role?.area === "domains" && role.role !== "repo";
};

/** The repo-relative path a static specifier names, or undefined for packages. */
export function targetPath(
  filename: string,
  source: string,
): string | undefined {
  if (source.startsWith("~/")) return posix.join(SRC, source.slice(2));
  if (source.startsWith("./") || source.startsWith("../"))
    return posix.normalize(posix.join(posix.dirname(filename), source));
}

type LayerMessage =
  | "upward"
  | "repoAi"
  | "policyImpure"
  | "serviceDb"
  | "platformUpward"
  | "uiUpward"
  | "entityUpward";

export function violation(
  from: string,
  to: string,
  typeOnly: boolean,
): LayerMessage | undefined {
  // Entry points compose services like operations, but stay importable
  // platform infrastructure (`workflows/runtime`, `http/request-context`).
  const fromRole: ReturnType<typeof roleOf> = ENTRY_PATH.test(from)
    ? { area: "entry", role: "operations" }
    : roleOf(from);
  const toRole = roleOf(to);
  if (from.startsWith(SERVER)) {
    if (fromRole?.role === "service" && isDbInternals(to)) return "serviceDb";
    if (typeOnly) return;
    if (AI_POLICY_PATH.test(from) && !AI_POLICY_PATH.test(to))
      return "policyImpure";
    if (fromRole?.role === "service" && isDb(to) && !isDbFreshness(to))
      return "serviceDb";
    if (fromRole?.role === "repo" && isAi(to)) return "repoAi";
    if (fromRole && toRole && RANK[toRole.role] > RANK[fromRole.role])
      return "upward";
    if (!fromRole && isDomainUpper(to)) return "platformUpward";
    if (fromRole?.area === "generic" && isDomainUpper(to))
      return "platformUpward";
    if (isDb(from) && toRole) return "upward";
    return;
  }
  if (typeOnly) return;
  if (
    from.startsWith(`${SRC}ui/`) &&
    /^apps\/web\/src\/(?:features|entity)\//u.test(to)
  )
    return "uiUpward";
  if (from.startsWith(`${SRC}entity/`) && to.startsWith(`${SRC}features/`))
    return "entityUpward";
}

export const domainLayersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep imports flowing operations → service → repo → db, and ui → entity → features never upward.",
    },
    messages: {
      upward:
        'A {{from}} module may not import "{{source}}" ({{to}}): roles import only the same or a lower layer (operations → service → repo → db). See docs/adr/0019-domain-first-server-layout.md.',
      repoAi:
        'A repo module may not import "{{source}}": model calls belong in a service. See docs/adr/0019-domain-first-server-layout.md.',
      policyImpure:
        'ai/policy/ may not import "{{source}}": AI policy declarations value-import only ai/policy/ and packages, so repos can read them without model code. See docs/adr/0019-domain-first-server-layout.md.',
      serviceDb:
        'A service may not import "{{source}}": reach the database through a repo function. See docs/adr/0019-domain-first-server-layout.md.',
      platformUpward:
        'Platform and generic code may not import a domain\'s service or operations ("{{source}}"); depend on its repo or invert the call. See docs/adr/0019-domain-first-server-layout.md.',
      uiUpward:
        'ui/ may not import "{{source}}": shared UI stays independent of entity and feature code.',
      entityUpward:
        'entity/ may not import "{{source}}": the entity platform stays independent of feature folders.',
    },
  },
  create(context) {
    const filename = relative(repoRoot, context.filename).split("\\").join("/");
    const skip = !filename.startsWith(SRC) || EXEMPT.test(filename);
    const check = (
      node: ESTree.Node,
      sourceNode: ESTree.Node | null | undefined,
      typeOnly: boolean,
    ) => {
      if (
        skip ||
        sourceNode?.type !== "Literal" ||
        typeof sourceNode.value !== "string"
      )
        return;
      const source = sourceNode.value;
      const to = targetPath(filename, source);
      if (!to) return;
      const messageId = violation(filename, to, typeOnly);
      if (!messageId) return;
      context.report({
        node,
        messageId,
        data: {
          source,
          from: ENTRY_PATH.test(filename)
            ? "operations"
            : (roleOf(filename)?.role ?? "platform"),
          to: roleOf(to)?.role ?? (isDb(to) ? "db" : "platform"),
        },
      });
    };
    return {
      ImportDeclaration(node) {
        const typeOnly =
          node.importKind === "type" ||
          (node.specifiers.length > 0 &&
            node.specifiers.every(
              (s) => s.type === "ImportSpecifier" && s.importKind === "type",
            ));
        check(node, node.source, typeOnly);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source, node.exportKind === "type");
      },
      ExportAllDeclaration(node) {
        check(node, node.source, node.exportKind === "type");
      },
      ImportExpression(node) {
        check(node, node.source, false);
      },
    };
  },
});
