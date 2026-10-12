import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

const COMPARISONS = new Set(["===", "!==", "==", "!=", ">", "<", ">=", "<="]);

/** Singular/plural suffix pairs a count ternary picks between. */
const SUFFIX_PAIRS = [
  ["", "s"],
  ["", "es"],
  ["y", "ies"],
];

function stringValue(node: ESTree.Node): string | undefined {
  if (node.type === "Literal") {
    const raw = node.raw ?? "";
    return raw.startsWith('"') || raw.startsWith("'")
      ? raw.slice(1, -1)
      : undefined;
  }
  if (node.type === "TemplateLiteral" && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

function isOne(node: ESTree.Node): boolean {
  return node.type === "Literal" && node.value === 1;
}

/**
 * `n === 1 ? "" : "s"` and its variants (`!== 1 ? "s" : ""`, `> 1`, `"es"`,
 * `"y"`/`"ies"`): an English plural spelled by hand. `countLabel` /
 * `pluralize` from `@cubby/shared/pluralize` handle irregular nouns
 * ("category" → "categories") that a suffix ternary gets wrong.
 */
export const noHandRolledPluralRule = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Pluralize nouns through countLabel/pluralize." },
    messages: {
      handRolledPlural:
        'Hand-written plural suffix. Use countLabel(count, "noun") from @cubby/shared/pluralize for "3 nouns", or pluralize("noun", count) for the noun alone.',
    },
  },
  createOnce(context) {
    return {
      ConditionalExpression(node) {
        const test = node.test;
        if (test.type !== "BinaryExpression") return;
        if (!COMPARISONS.has(test.operator)) return;
        if (!isOne(test.left) && !isOne(test.right)) return;
        const consequent = stringValue(node.consequent);
        const alternate = stringValue(node.alternate);
        if (consequent === undefined || alternate === undefined) return;
        const matches = SUFFIX_PAIRS.some(
          ([singular, plural]) =>
            (consequent === singular && alternate === plural) ||
            (consequent === plural && alternate === singular),
        );
        if (matches) context.report({ node, messageId: "handRolledPlural" });
      },
    };
  },
});
