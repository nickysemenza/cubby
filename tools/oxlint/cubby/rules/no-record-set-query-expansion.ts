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

export const noRecordSetQueryExpansionRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Bind record sets as array-backed requested relations.",
    },
    messages: {
      expansion:
        "Use requested() or requestedRows() for a record set instead of expanding query parameters.",
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
      !/apps\/web\/src\/server\/.*\/repo\//.test(relativeFilename) ||
      /(?:photo-product-candidates|expense-link)\.ts$/.test(relativeFilename)
    )
      return {};
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
        if (node.callee.type !== "Identifier" || node.callee.name !== "or")
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
          if (!/\bVALUES\s*$/i.test(node.quasi.quasis[i]?.value.raw ?? ""))
            continue;
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
