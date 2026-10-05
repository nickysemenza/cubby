import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * The purchase agent (`apps/web/src/server/purchase-agent/`) reads untrusted
 * vendor pages, mail, and photos inside the web Worker. Its only authority is
 * the narrowed environment its host passes in (`environment.ts`): this rule
 * keeps the directory from importing anything that could reach the database,
 * a binding, or a secret, and from reading the Worker's raw environment.
 * docs/infrastructure.md#purchase-agent explains the boundary.
 */

const BOUNDARY = "See docs/infrastructure.md#purchase-agent.";

/** Packages the agent may import: its runtime and pure Cubby contracts. */
const ALLOWED_PACKAGES = [
  /^@cubby\/schemas(\/|$)/u,
  /^@cubby\/shared(\/|$)/u,
  /^@cubby\/worker-tracing(\/|$)/u,
  /^@earendil-works\//u,
  /^agents(\/|$)/u,
  /^@modelcontextprotocol\/client$/u,
  /^@sentry\/cloudflare$/u,
  /^@cloudflare\/workers-types$/u,
  /^zod$/u,
];

/** The bundled skill Markdown the coordinator's workflow is built from. */
const SKILL_MARKDOWN = /^(\.\.\/)+\.claude\/skills\/[^?]+\.md\?raw$/u;

function allowedSource(source: string): boolean {
  if (source.startsWith("./")) return !source.includes("/../");
  if (source.startsWith("../")) return SKILL_MARKDOWN.test(source);
  return ALLOWED_PACKAGES.some((pattern) => pattern.test(source));
}

/** A quoted string literal's value (`"zod"` → zod). */
function staticSource(node: ESTree.Node | null | undefined) {
  if (node?.type !== "Literal" || node.raw === null) return;
  if (!node.raw.startsWith('"') && !node.raw.startsWith("'")) return;
  return String(node.value);
}

function memberOf(node: ESTree.Node, object: string, property: string) {
  if (node.type !== "MemberExpression" || node.computed) return false;
  const left =
    (node.object.type === "Identifier" && node.object.name === object) ||
    (object === "this" && node.object.type === "ThisExpression");
  return (
    left &&
    node.property.type === "Identifier" &&
    node.property.name === property
  );
}

export const purchaseAgentBoundaryRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep the purchase agent on its narrowed environment: no database, binding, secret, or raw env access.",
    },
    messages: {
      import: `The purchase agent may not import "{{source}}": it reaches Cubby only through its narrowed environment (environment.ts), whose Run services the host implements. Add the capability as a run-scoped service instead. ${BOUNDARY}`,
      dynamicImport: `The purchase agent may import only static, allowed modules. ${BOUNDARY}`,
      env: `The purchase agent may not read {{what}}; its host passes everything it may use in the narrowed environment (environment.ts). ${BOUNDARY}`,
    },
  },
  createOnce(context) {
    const checkSource = (
      node: ESTree.Node,
      source: ESTree.Node | null | undefined,
    ) => {
      const value = staticSource(source);
      if (value === undefined) return;
      if (!allowedSource(value))
        context.report({ node, messageId: "import", data: { source: value } });
    };
    return {
      ImportDeclaration(node) {
        checkSource(node, node.source);
      },
      ExportNamedDeclaration(node) {
        checkSource(node, node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source);
      },
      ImportExpression(node) {
        if (staticSource(node.source) === undefined)
          context.report({ node, messageId: "dynamicImport" });
        else checkSource(node, node.source);
      },
      MemberExpression(node) {
        if (memberOf(node, "process", "env"))
          context.report({
            node,
            messageId: "env",
            data: { what: "process.env" },
          });
        if (memberOf(node, "this", "env"))
          context.report({
            node,
            messageId: "env",
            data: { what: "this.env" },
          });
      },
    };
  },
});
