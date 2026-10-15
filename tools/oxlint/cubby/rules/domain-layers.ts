import { readFileSync } from "node:fs";
import { dirname, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { z } from "zod";

/**
 * Layer direction for the domain-first layout (docs/adr/0019-domain-first-server-layout.md).
 *
 * Server: a role is the path segment after `domains/<x>/` or `generic/<x>/`
 * (`repo`, `service`, `operations`, as a folder or a `<role>.ts` file). Roles
 * import only the same or a lower role (`operations` → `service` → `repo` →
 * `db`), in any domain; `repo` never imports `ai/`; `service` reaches the
 * database only through a repo; platform folders and `generic/*` never import a
 * domain's `service` or `operations`.
 *
 * Client: `ui/` imports neither `features/` nor `entity/`; `entity/` does not
 * import `features/`.
 *
 * Tests, fixtures, and live evals are exempt. Existing violations are counted
 * per file in `domain-layers-baseline.json`; a file may only shrink its count.
 */

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const baseline = z
  .record(z.string(), z.number().int().positive())
  .parse(
    JSON.parse(
      readFileSync(
        resolve(repoRoot, "tools/oxlint/cubby/domain-layers-baseline.json"),
        "utf8",
      ),
    ),
  );

const SRC = "apps/web/src/";
const SERVER = `${SRC}server/`;
const RANK = { repo: 1, service: 2, operations: 3 } as const;
type Role = keyof typeof RANK;
const ROLE_PATH =
  /^apps\/web\/src\/server\/(domains|generic)\/([^/]+)\/(repo|service|operations)(?:[./]|$)/u;
const EXEMPT = /\.(?:test|spec)\.tsx?$|\.fixtures\.tsx?$|\.live-eval\.ts$/u;

const isRole = (value: string | undefined): value is Role =>
  value === "repo" || value === "service" || value === "operations";

function roleOf(path: string): { area: string; role: Role } | undefined {
  const match = ROLE_PATH.exec(path);
  const role = match?.[3];
  if (!match || !isRole(role)) return;
  return { area: match[1]!, role };
}

const isDb = (path: string) =>
  /^apps\/web\/src\/server\/db(?:[./]|$)/u.test(path);
const isDbInternals = (path: string) =>
  /^apps\/web\/src\/server\/db\/(?:schema|helpers)(?:[./]|$)/u.test(path);
const isAi = (path: string) =>
  /^apps\/web\/src\/server\/ai(?:[./]|$)/u.test(path);
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
  | "serviceDb"
  | "platformUpward"
  | "uiUpward"
  | "entityUpward";

export function violation(
  from: string,
  to: string,
  typeOnly: boolean,
): LayerMessage | undefined {
  const fromRole = roleOf(from);
  const toRole = roleOf(to);
  if (from.startsWith(SERVER)) {
    if (fromRole?.role === "service" && isDbInternals(to)) return "serviceDb";
    if (typeOnly) return;
    if (fromRole?.role === "repo" && isAi(to)) return "repoAi";
    if (fromRole && toRole && RANK[toRole.role] > RANK[fromRole.role])
      return "upward";
    if (!fromRole && !from.startsWith(`${SERVER}domains/`) && isDomainUpper(to))
      return "platformUpward";
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
      serviceDb:
        'A service may not import "{{source}}": reach the database through a repo function. See docs/adr/0019-domain-first-server-layout.md.',
      platformUpward:
        'Platform and generic code may not import a domain\'s service or operations ("{{source}}"); depend on its repo or invert the call. See docs/adr/0019-domain-first-server-layout.md.',
      uiUpward:
        'ui/ may not import "{{source}}": shared UI stays independent of entity and feature code.',
      entityUpward:
        'entity/ may not import "{{source}}": the entity platform stays independent of feature folders.',
      staleBaseline:
        "This file has {{actual}} layer violations, below its baseline of {{allowed}}; lower tools/oxlint/cubby/domain-layers-baseline.json.",
    },
  },
  create(context) {
    const filename = relative(repoRoot, context.filename).split("\\").join("/");
    const skip = !filename.startsWith(SRC) || EXEMPT.test(filename);
    let program: ESTree.Program | undefined;
    const found: {
      node: ESTree.Node;
      messageId: LayerMessage;
      data: Record<string, string>;
    }[] = [];
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
      found.push({
        node,
        messageId,
        data: {
          source,
          from: roleOf(filename)?.role ?? "platform",
          to: roleOf(to)?.role ?? (isDb(to) ? "db" : "platform"),
        },
      });
    };
    return {
      Program(node) {
        program = node;
      },
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
      "Program:exit"() {
        if (skip || !program) return;
        const allowed = baseline[filename] ?? 0;
        if (found.length < allowed) {
          context.report({
            node: program,
            messageId: "staleBaseline",
            data: { actual: String(found.length), allowed: String(allowed) },
          });
          return;
        }
        if (found.length <= allowed) return;
        for (const { node, messageId, data } of found)
          context.report({ node, messageId, data });
      },
    };
  },
});
