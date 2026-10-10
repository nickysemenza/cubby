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
const schemaRoot = resolve(repoRoot, "packages/schemas/src");
const baseline = z
  .record(z.number().int().nonnegative())
  .parse(
    JSON.parse(
      readFileSync(
        resolve(
          repoRoot,
          "tools/oxlint/cubby/no-raw-enum-literal-in-sql-baseline.json",
        ),
        "utf8",
      ),
    ),
  );

function schemaFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return schemaFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  });
}

function collectVocabulary(): Set<string> {
  const values = new Set<string>();
  const declaration =
    /export\s+const\s+\w+Values\s*=\s*\[([\s\S]*?)\]\s*(?:as\s+const)?/g;
  // Schema vocabulary is declared either as exported *Values tuples or as
  // direct string arrays passed to z.enum. Computed enum declarations are not
  // inferred here; they should use an exported *Values tuple.
  const inlineEnum = /z\.enum\s*\(\s*\[([\s\S]*?)\]/g;
  const strings = /["']([^"'\\]+)["']/g;
  function addStrings(body: string) {
    strings.lastIndex = 0;
    let item: RegExpExecArray | null;
    while ((item = strings.exec(body))) if (item[1]) values.add(item[1]);
  }
  for (const path of schemaFiles(schemaRoot)) {
    const source = readFileSync(path, "utf8");
    declaration.lastIndex = 0;
    inlineEnum.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(source))) addStrings(match[1] ?? "");
    while ((match = inlineEnum.exec(source))) addStrings(match[1] ?? "");
  }
  return values;
}

const vocabulary = collectVocabulary();
const sqlLiteral = /'((?:\\.|[^'\\])*)'/g;

export const noRawEnumLiteralInSqlRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow schema vocabulary literals in Drizzle SQL templates.",
    },
    messages: {
      rawEnumLiteral:
        "Use the shared schema vocabulary value for '{{value}}' instead of a raw enum literal in SQL.",
      staleBaseline:
        "This file has {{actual}} raw enum SQL literals, below its baseline of {{allowed}}; lower the baseline.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    const relativeFilename = filename.startsWith(`${repoRoot}/`)
      ? filename.slice(repoRoot.length + 1)
      : filename;
    const violations: { node: ESTree.Node; value: string }[] = [];
    let program: ESTree.Program | undefined;
    return {
      Program(node) {
        program = node;
      },
      TaggedTemplateExpression(node) {
        if (node.tag.type !== "Identifier" || node.tag.name !== "sql") return;
        for (const quasi of node.quasi.quasis) {
          const text = quasi.value.raw;
          sqlLiteral.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = sqlLiteral.exec(text))) {
            const value = match[1]?.replaceAll("\\'", "'");
            if (value !== undefined && vocabulary.has(value))
              violations.push({ node, value });
          }
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
        if (violations.length <= allowed) return;
        for (const { node, value } of violations)
          context.report({
            node,
            messageId: "rawEnumLiteral",
            data: { value },
          });
      },
    };
  },
});
