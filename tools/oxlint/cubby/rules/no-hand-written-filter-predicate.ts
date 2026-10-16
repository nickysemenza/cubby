import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode, Variable } from "@oxlint/plugins";
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

const resolveVariable = (
  sourceCode: SourceCode,
  identifier: ESTree.IdentifierReference,
): Variable | null => {
  let scope: Scope | null = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
    scope = scope.upper;
  }
  return null;
};

/** The `[...]` a `const` condition list is initialized with. */
const declaredArray = (variable: Variable): ESTree.ArrayExpression | null => {
  const [definition] = variable.defs;
  const declarator = definition?.node;
  return declarator?.type === "VariableDeclarator" &&
    declarator.init?.type === "ArrayExpression"
    ? declarator.init
    : null;
};

/** Every argument list of a `list.push(...)` on this binding. */
const pushedArguments = (variable: Variable) =>
  variable.references.flatMap((reference) => {
    const member = reference.identifier.parent;
    const call = member?.parent;
    return member?.type === "MemberExpression" &&
      member.object === reference.identifier &&
      member.property.type === "Identifier" &&
      member.property.name === "push" &&
      call?.type === "CallExpression" &&
      call.callee === member
      ? call.arguments
      : [];
  });

/**
 * Hand-written conditions in a list scaffold's `where(filters, [...])`. A
 * condition list bound in the file counts its elements and everything pushed
 * onto that binding, through spreads; any other opaque value counts as one.
 */
const countConditions = (
  node: ESTree.Node | null,
  sourceCode: SourceCode,
  seen: Set<Variable>,
): number => {
  if (node === null) return 0;
  const count = (child: ESTree.Node | null) =>
    countConditions(child, sourceCode, seen);
  if (node.type === "ArrayExpression")
    return node.elements.reduce((total, element) => total + count(element), 0);
  if (node.type === "SpreadElement") return count(node.argument);
  if (node.type === "Identifier") {
    const variable = resolveVariable(sourceCode, node);
    const array = variable ? declaredArray(variable) : null;
    if (variable && array && !seen.has(variable)) {
      // `seen` guards only the current expansion, so a list spread twice
      // counts twice.
      seen.add(variable);
      const total =
        count(array) +
        pushedArguments(variable).reduce(
          (sum, argument) => sum + count(argument),
          0,
        );
      seen.delete(variable);
      return total;
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
        calls.push(node);
      },
      "Program:exit"() {
        const violations = calls
          .map((node) => ({
            node,
            count: countConditions(
              node.arguments[1] ?? null,
              context.sourceCode,
              new Set(),
            ),
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
