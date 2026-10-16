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

/** Same-file condition lists: `const name = [...]` and each `name.push(...)`. */
type ConditionLists = {
  arrays: Map<string, ESTree.ArrayExpression>;
  pushed: Map<string, number>;
};

/**
 * Hand-written conditions in a list scaffold's `where(filters, [...])`. A
 * condition list named in the same file counts its elements and every
 * argument pushed onto it; any other opaque list or spread counts as one.
 */
const countConditions = (
  node: ESTree.Node | null,
  lists: ConditionLists,
  seen: Set<string>,
): number => {
  if (node === null) return 0;
  if (node.type === "ArrayExpression")
    return node.elements.reduce(
      (total, element) => total + countConditions(element, lists, seen),
      0,
    );
  if (node.type === "SpreadElement")
    return countConditions(node.argument, lists, seen);
  if (node.type === "Identifier" && !seen.has(node.name)) {
    const array = lists.arrays.get(node.name);
    if (array) {
      seen.add(node.name);
      return (
        countConditions(array, lists, seen) + (lists.pushed.get(node.name) ?? 0)
      );
    }
  }
  return 1;
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
    const calls: ESTree.CallExpression[] = [];
    const lists: ConditionLists = { arrays: new Map(), pushed: new Map() };
    let program: ESTree.Program | undefined;
    return {
      Program(node) {
        program = node;
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          node.init?.type === "ArrayExpression"
        )
          lists.arrays.set(node.id.name, node.init);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "push" &&
          callee.object.type === "Identifier"
        ) {
          const name = callee.object.name;
          lists.pushed.set(
            name,
            (lists.pushed.get(name) ?? 0) + node.arguments.length,
          );
          return;
        }
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "where" ||
          callee.object.type !== "Identifier" ||
          !scaffoldName.test(callee.object.name)
        )
          return;
        calls.push(node);
      },
      "Program:exit"() {
        const violations = calls
          .map((node) => ({
            node,
            count: countConditions(node.arguments[1] ?? null, lists, new Set()),
          }))
          .filter(({ count }) => count > 0);
        const actual = violations.reduce(
          (total, { count }) => total + count,
          0,
        );
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
