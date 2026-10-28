import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { z } from "zod";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const definitions = resolve(
  repoRoot,
  "packages/schemas/src/entity-definitions",
);
const entityKeys = new Set(
  readdirSync(definitions)
    .filter((name) => name.endsWith(".entity.ts"))
    .map((name) => {
      const source = readFileSync(resolve(definitions, name), "utf8");
      const key = /defineEntityModel\s*\(\s*\{\s*key:\s*["']([^"']+)["']/.exec(
        source,
      )?.[1];
      if (!key) throw new Error(`Missing entity key in ${name}`);
      return key;
    }),
);
const baseline = z
  .record(z.number().int().nonnegative())
  .parse(
    JSON.parse(
      readFileSync(
        resolve(repoRoot, "tools/oxlint/cubby/no-entity-roster-baseline.json"),
        "utf8",
      ),
    ),
  );

function entityKeyType(text: string): boolean {
  if (/\b(?:Entity|\w*Entity(?:Key|Kind|Type)?|ShortcodeType)\b/.test(text))
    return true;
  return [...text.matchAll(/["']([^"']+)["']/g)].some((match) =>
    entityKeys.has(match[1] ?? ""),
  );
}

export const noEntityRosterRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep entity read dispatch in repository declarations, not generic rosters.",
    },
    messages: {
      roster:
        "This file has {{actual}} entity rosters, above its baseline of {{allowed}}; use declarations and generic ports instead.",
      staleBaseline:
        "This file has {{actual}} entity rosters, below its baseline of {{allowed}}; lower the baseline.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const relativeFilename = filename.startsWith(`${repoRoot}/`)
      ? filename.slice(repoRoot.length + 1)
      : filename;
    let total = 0;
    let first: ESTree.Node | undefined;
    let program: ESTree.Program | undefined;
    const note = (node: ESTree.Node) => {
      total++;
      first ??= node;
    };
    return {
      Program(node) {
        program = node;
      },
      ObjectExpression(node) {
        let container: ESTree.Node = node;
        while (
          container.parent?.type === "TSAsExpression" ||
          container.parent?.type === "TSSatisfiesExpression"
        )
          container = container.parent;
        if (
          container.parent?.type !== "VariableDeclarator" &&
          container.parent?.type !== "ReturnStatement"
        )
          return;
        const keys = node.properties.flatMap((property) => {
          if (property.type !== "Property") return [];
          if (!property.computed && property.key.type === "Identifier")
            return [property.key.name];
          if (
            property.key.type === "Literal" &&
            typeof property.key.value === "string"
          )
            return [property.key.value];
          return [];
        });
        const matches = keys.filter((key) => entityKeys.has(key)).length;
        if (matches >= 2) note(node);
        else {
          const text = context.sourceCode.getText(container.parent);
          const keyType = /\bRecord\s*<\s*([^,>]+)/.exec(text)?.[1] ?? "";
          if (entityKeyType(keyType)) note(node);
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || !node.init) return;
        const declaration = node.parent;
        const outer = declaration?.parent;
        const annotation = node.id.typeAnnotation
          ? context.sourceCode.getText(node.id.typeAnnotation)
          : "";
        if (
          node.init.type === "NewExpression" &&
          node.init.callee.type === "Identifier" &&
          node.init.callee.name === "Map" &&
          (outer?.type === "Program" ||
            outer?.type === "ExportNamedDeclaration")
        ) {
          const text = context.sourceCode.getText(node.init);
          const type =
            /\b(?:Map|ReadonlyMap)\s*<\s*([^,>]+)/.exec(
              `${annotation} ${text}`,
            )?.[1] ?? "";
          const literalKeys = [
            ...text.matchAll(/\[\s*["']([^"']+)["']\s*,/g),
          ].filter((match) => entityKeys.has(match[1] ?? ""));
          if (entityKeyType(type) || literalKeys.length > 0) note(node);
        } else {
          let expression = node.init;
          let typeText = annotation;
          while (
            expression.type === "TSAsExpression" ||
            expression.type === "TSSatisfiesExpression"
          ) {
            typeText += context.sourceCode.getText(expression.typeAnnotation);
            expression = expression.expression;
          }
          const keyType = /\bRecord\s*<\s*([^,>]+)/.exec(typeText)?.[1] ?? "";
          if (expression.type !== "ObjectExpression" && entityKeyType(keyType))
            note(node);
        }
      },
      "Program:exit"() {
        const allowed = baseline[relativeFilename] ?? 0;
        if (total < allowed)
          context.report({
            node: program!,
            messageId: "staleBaseline",
            data: { actual: total, allowed },
          });
        else if (total > allowed)
          context.report({
            node: first ?? program!,
            messageId: "roster",
            data: { actual: total, allowed },
          });
      },
    };
  },
});
