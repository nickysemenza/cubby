import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { z } from "zod";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
/**
 * Shrink-only (#2409): the filter migration (#2410, #2411) removes entries as
 * it declares each predicate, and never adds one. #2411 deletes the rule.
 */
const baseline = z
  .record(z.number().int().nonnegative())
  .parse(
    JSON.parse(
      readFileSync(
        resolve(
          repoRoot,
          "tools/oxlint/cubby/no-hand-written-filter-predicate-baseline.json",
        ),
        "utf8",
      ),
    ),
  );

/** A list scaffold binding: `listScaffold(...)` results are named `*Scaffold`. */
const scaffoldName = /(?:^s|S)caffold$/;

/**
 * Hand-written conditions passed to a list scaffold's `where(filters, [...])`.
 * An opaque (non-literal) condition list counts as one.
 */
const handWrittenConditions = (node: ESTree.CallExpression): number => {
  const computed = node.arguments[1];
  if (computed === undefined) return 0;
  return computed.type === "ArrayExpression"
    ? computed.elements.filter((element) => element !== null).length
    : 1;
};

export const noHandWrittenFilterPredicateRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow new hand-written list filter predicates beside a scaffold's declared ones.",
    },
    messages: {
      handWritten:
        "{{count}} hand-written list filter predicate(s): declare them (stored, model.derived, or a predicate exception with its reason) instead.",
      staleBaseline:
        "This file has {{actual}} hand-written list filter predicates, below its baseline of {{allowed}}; lower the baseline.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    // Tests exercise the hook; only repositories carry predicates.
    if (/\.test\.tsx?$/.test(filename)) return {};
    const relativeFilename = filename.startsWith(`${repoRoot}/`)
      ? filename.slice(repoRoot.length + 1)
      : filename;
    const violations: { node: ESTree.Node; count: number }[] = [];
    let actual = 0;
    let program: ESTree.Program | undefined;
    return {
      Program(node) {
        program = node;
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "where" ||
          callee.object.type !== "Identifier" ||
          !scaffoldName.test(callee.object.name)
        )
          return;
        const count = handWrittenConditions(node);
        if (count === 0) return;
        actual += count;
        violations.push({ node, count });
      },
      "Program:exit"() {
        const allowed = baseline[relativeFilename] ?? 0;
        if (actual < allowed) {
          context.report({
            node: program!,
            messageId: "staleBaseline",
            data: { actual, allowed },
          });
          return;
        }
        if (actual <= allowed) return;
        for (const { node, count } of violations)
          context.report({ node, messageId: "handWritten", data: { count } });
      },
    };
  },
});
