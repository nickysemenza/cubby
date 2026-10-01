import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

/**
 * Enforcement for AGENTS.md "Generic by default": each rule flags a hand-rolled
 * form of something a shared generic path already does
 * (docs/agents/generic-paths.md). Files that still use the old form are listed
 * in a `.oxlintrc.json` override that turns the rule off for them — that list
 * is the shrink-only baseline: remove a file once it is migrated, never add one.
 */

const CATALOG = "See docs/agents/generic-paths.md.";

function memberPropertyName(node: ESTree.Node): string | undefined {
  if (node.type !== "MemberExpression" || node.computed) return undefined;
  return node.property.type === "Identifier" ? node.property.name : undefined;
}

/** `object.property` where both sides are plain identifiers. */
function identifierMember(
  node: ESTree.Node,
): { object: string; property: string } | undefined {
  const property = memberPropertyName(node);
  if (property === undefined || node.type !== "MemberExpression") return;
  if (node.object.type !== "Identifier") return;
  return { object: node.object.name, property };
}

/** A numeric literal's value, from its source text (`100_000` → 100000). */
function numericLiteral(node: ESTree.Node): number | undefined {
  if (node.type !== "Literal" || node.raw === null) return;
  const value = Number(node.raw.replaceAll("_", ""));
  return Number.isFinite(value) ? value : undefined;
}

/** True for a quoted string literal (`"update"`). */
function isStringLiteral(node: ESTree.Node): boolean {
  if (node.type !== "Literal" || node.raw === null) return false;
  return node.raw.startsWith('"') || node.raw.startsWith("'");
}

/** `console.log(...)` and friends. */
export const noRawConsoleRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Use createLogger instead of raw console calls." },
    messages: {
      rawConsole: `Use createLogger("<scope>") from @cubby/worker-tracing instead of console.{{method}}. ${CATALOG}`,
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (callee.object.type !== "Identifier") return;
        if (callee.object.name !== "console") return;
        context.report({
          node,
          messageId: "rawConsole",
          data: { method: memberPropertyName(callee) ?? "?" },
        });
      },
    };
  },
});

/** `new Intl.NumberFormat(...)` and `x.toFixed(n)` outside the shared formatters. */
export const noAdHocNumberFormatRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Format and round numbers through lib/utils." },
    messages: {
      intl: `Use the lib/utils formatters (formatCurrency, formatCount, formatPercent, compact variants) instead of new Intl.NumberFormat. ${CATALOG}`,
      toFixed: `Use roundTo / the lib/utils formatters instead of toFixed. ${CATALOG}`,
    },
  },
  createOnce(context) {
    return {
      NewExpression(node) {
        const member = identifierMember(node.callee);
        if (member?.object === "Intl" && member.property === "NumberFormat")
          context.report({ node, messageId: "intl" });
      },
      CallExpression(node) {
        if (memberPropertyName(node.callee) === "toFixed")
          context.report({ node, messageId: "toFixed" });
      },
    };
  },
});

/** `pageSize: 100_000` — an unbounded read disguised as one page. */
export const noUnboundedPageSizeRule = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Use listAll for unbounded reads." },
    messages: {
      unbounded: `A literal pageSize of {{value}} bypasses MAX_PAGE_SIZE; use listAll (server) or useAllEntityRecords (client). ${CATALOG}`,
    },
  },
  createOnce(context) {
    return {
      Property(node) {
        if (node.key.type !== "Identifier" || node.key.name !== "pageSize")
          return;
        const value = numericLiteral(node.value);
        if (value !== undefined && value >= 10_000)
          context.report({
            node,
            messageId: "unbounded",
            data: { value: String(value) },
          });
      },
    };
  },
});

/** `if (result.action !== "update") throw …` after a kernel call. */
export const noKernelActionGuardRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Use executeEntityAs instead of narrowing kernel results by hand.",
    },
    messages: {
      guard: `Call executeEntityAs(ctx, action, command) instead of checking result.action by hand. ${CATALOG}`,
    },
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== "!==" && node.operator !== "===") return;
        const sides = [node.left, node.right];
        const member = sides
          .map(identifierMember)
          .find((candidate) => candidate?.property === "action");
        if (!member || !sides.some(isStringLiteral)) return;
        if (member.object.toLowerCase().endsWith("result"))
          context.report({ node, messageId: "guard" });
      },
    };
  },
});

/** Raw `<table>` outside the shared table components. */
export const noRawTableRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Render tabular data through RTable or the relation table.",
    },
    messages: {
      rawTable: `Use RTable or the generic relation table instead of a raw <table>; raw tables are for matrices, cross-tabs, and debug views (baseline them). ${CATALOG}`,
    },
  },
  createOnce(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type === "JSXIdentifier" && node.name.name === "table")
          context.report({ node, messageId: "rawTable" });
      },
    };
  },
});

/** `productCreateInput.parse({...})` in tests and tooling. */
export const noHandParsedCreateInputRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Build test entities through the factories." },
    messages: {
      handParsed: `Build entities with buildEntity / createEntity (apps/web/tooling/factories) instead of {{name}}.parse. ${CATALOG}`,
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        const member = identifierMember(node.callee);
        if (
          member?.property === "parse" &&
          member.object.endsWith("CreateInput")
        )
          context.report({
            node,
            messageId: "handParsed",
            data: { name: member.object },
          });
      },
    };
  },
});
