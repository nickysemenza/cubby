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
const baseline = z
  .record(z.number().int().nonnegative())
  .parse(
    JSON.parse(
      readFileSync(
        resolve(
          repoRoot,
          "tools/oxlint/cubby/no-record-set-query-expansion-baseline.json",
        ),
        "utf8",
      ),
    ),
  );

/**
 * The mapper binds each element as a parameter. Mappers that render
 * `sql.raw`, enum constants or literals emit static SQL, not parameters.
 */
function bindsElement(mapper: ESTree.Node | undefined): boolean {
  if (
    mapper?.type !== "ArrowFunctionExpression" &&
    mapper?.type !== "FunctionExpression"
  )
    return false;
  const body = mapper.body;
  if (body.type === "CallExpression") return false;
  if (body.type !== "TaggedTemplateExpression") return true;
  return body.quasi.expressions.some(
    (expression) => expression.type !== "CallExpression",
  );
}

/**
 * `sql.join(x.map(...))` over a runtime list. Array literals and SCREAMING_CASE
 * constants are static declarations, not request-sized sets.
 */
function isRequestSetJoin(expression: ESTree.Expression | undefined): boolean {
  if (
    expression?.type !== "CallExpression" ||
    expression.callee.type !== "MemberExpression" ||
    expression.callee.computed ||
    expression.callee.object.type !== "Identifier" ||
    expression.callee.object.name !== "sql" ||
    expression.callee.property.type !== "Identifier" ||
    expression.callee.property.name !== "join"
  )
    return false;
  const joined = expression.arguments[0];
  if (
    joined?.type !== "CallExpression" ||
    joined.callee.type !== "MemberExpression" ||
    joined.callee.computed ||
    joined.callee.property.type !== "Identifier" ||
    joined.callee.property.name !== "map"
  )
    return false;
  if (!bindsElement(joined.arguments[0])) return false;
  const source = joined.callee.object;
  if (source.type === "ArrayExpression") return false;
  const name =
    source.type === "Identifier"
      ? source.name
      : source.type === "MemberExpression" &&
          !source.computed &&
          source.property.type === "Identifier"
        ? source.property.name
        : undefined;
  return !(name && /^[A-Z][A-Z0-9_]*$/.test(name));
}

export const noRecordSetQueryExpansionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Bind record sets as array-backed requested relations.",
    },
    messages: {
      expansion:
        "Use requested(), requestedRows() or an array parameter (= ANY) for a record set instead of expanding query parameters.",
      staleBaseline:
        "This file has {{actual}} record-set expansions, below its baseline of {{allowed}}; lower the baseline.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const relativeFilename = filename.startsWith(`${repoRoot}/`)
      ? filename.slice(repoRoot.length + 1)
      : filename;
    if (
      !relativeFilename.startsWith("apps/web/src/server/") ||
      /(?:photo-product-candidates|expense-link)\.ts$/.test(relativeFilename)
    )
      return {};
    // `IN (sql.join(...))` is banned across server code; the other shapes in repositories.
    const inRepository = /apps\/web\/src\/server\/.*\/repo\//.test(
      relativeFilename,
    );
    if (
      /\.(?:test|tmp)\.ts$/.test(relativeFilename) ||
      relativeFilename.endsWith("predicate-compiler.ts")
    )
      return {};
    const violations: ESTree.Node[] = [];
    let program: ESTree.Program | undefined;
    return {
      Program(node) {
        program = node;
      },
      CallExpression(node) {
        if (
          !inRepository ||
          node.callee.type !== "Identifier" ||
          node.callee.name !== "or"
        )
          return;
        for (const arg of node.arguments) {
          if (
            arg.type !== "SpreadElement" ||
            arg.argument.type !== "CallExpression"
          )
            continue;
          const callee = arg.argument.callee;
          if (
            callee.type !== "MemberExpression" ||
            callee.computed ||
            callee.property.type !== "Identifier" ||
            callee.property.name !== "map"
          )
            continue;
          // Declared columns, checks, milestones and keyset sort terms, not requested rows.
          if (
            callee.object.type === "Identifier" &&
            ["MILESTONES", "admittedChecks", "rest", "terms"].includes(
              callee.object.name,
            )
          )
            continue;
          if (
            relativeFilename.endsWith("domains/product/repo/crud.ts") &&
            callee.object.type !== "Identifier"
          )
            continue;
          violations.push(node);
          break;
        }
      },
      TaggedTemplateExpression(node) {
        if (node.tag.type !== "Identifier" || node.tag.name !== "sql") return;
        for (let i = 0; i < node.quasi.expressions.length; i++) {
          const preceding = node.quasi.quasis[i]?.value.raw ?? "";
          if (/\bIN\s*\(\s*$/i.test(preceding)) {
            if (isRequestSetJoin(node.quasi.expressions[i]))
              violations.push(node);
            continue;
          }
          if (!inRepository || !/\bVALUES\s*$/i.test(preceding)) continue;
          const expression = node.quasi.expressions[i];
          if (
            expression?.type !== "CallExpression" ||
            expression.callee.type !== "MemberExpression" ||
            expression.callee.computed ||
            expression.callee.object.type !== "Identifier" ||
            expression.callee.object.name !== "sql" ||
            expression.callee.property.type !== "Identifier" ||
            expression.callee.property.name !== "join"
          )
            continue;
          // Declared settlement reference paths are static declarations.
          const joined = expression.arguments[0];
          if (
            joined?.type === "CallExpression" &&
            joined.callee.type === "MemberExpression" &&
            joined.callee.object.type === "Identifier" &&
            joined.callee.object.name === "related"
          )
            continue;
          // Work reasons and declared derived-field keys are static declarations.
          if (
            /(?:work-declarations|derived\/repo\/read)\.ts$/.test(
              relativeFilename,
            )
          )
            continue;
          violations.push(node);
        }
      },
      "Program:exit"() {
        const allowed = baseline[relativeFilename] ?? 0;
        if (violations.length < allowed) {
          context.report({
            node: program!,
            messageId: "staleBaseline",
            data: { actual: violations.length, allowed },
          });
          return;
        }
        if (violations.length > allowed)
          for (const node of violations)
            context.report({ node, messageId: "expansion" });
      },
    };
  },
});
