import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

function isSqlTag(tag: ESTree.Expression): boolean {
  if (tag.type === "Identifier") return tag.name === "sql";
  return (
    tag.type === "TSInstantiationExpression" &&
    tag.expression.type === "Identifier" &&
    tag.expression.name === "sql"
  );
}

function isUuidArrayParam(expression: ESTree.Expression): boolean {
  return (
    expression.type === "CallExpression" &&
    expression.callee.type === "Identifier" &&
    expression.callee.name === "uuidArrayParam"
  );
}

function templateText(element: ESTree.TemplateElement): string {
  return element.value.cooked ?? element.value.raw;
}

/** Require typed helpers for array interpolation in Drizzle sql templates. */
export const noUnsafeSqlArrayInterpolationRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow unsafe array interpolation in Drizzle sql templates; use typed query helpers instead.",
    },
    messages: {
      unsafeAny:
        "Unsafe `ANY(${array})` interpolation; use `uuidArrayParam` for UUID arrays or a typed query helper.",
      unsafeOverlap:
        "Unsafe `&& ${array}` interpolation; use a typed query helper.",
    },
  },
  createOnce(context) {
    return {
      TaggedTemplateExpression(node) {
        if (!isSqlTag(node.tag)) return;

        for (const [index, expression] of node.quasi.expressions.entries()) {
          const precedingText = templateText(node.quasi.quasis[index]!);
          if (/\bANY\s*\(\s*$/i.test(precedingText)) {
            if (!isUuidArrayParam(expression)) {
              context.report({ node: expression, messageId: "unsafeAny" });
            }
          } else if (/&&\s*$/.test(precedingText)) {
            context.report({ node: expression, messageId: "unsafeOverlap" });
          }
        }
      },
    };
  },
});
