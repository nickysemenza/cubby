import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineRule } from "@oxlint/plugins";
import { z } from "zod";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const schemaRoot = resolve(repoRoot, "packages/schemas/src");
const baseline = new Set(
  z
    .array(z.string())
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
  const strings = /["']([^"'\\]+)["']/g;
  for (const path of schemaFiles(schemaRoot)) {
    const source = readFileSync(path, "utf8");
    declaration.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(source))) {
      const body = match[1];
      if (!body) continue;
      strings.lastIndex = 0;
      let item: RegExpExecArray | null;
      while ((item = strings.exec(body))) if (item[1]) values.add(item[1]);
    }
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
    },
  },
  create(context) {
    return {
      TaggedTemplateExpression(node) {
        const filename = context.filename.replaceAll("\\", "/");
        const relativeFilename = filename.startsWith(`${repoRoot}/`)
          ? filename.slice(repoRoot.length + 1)
          : filename;
        if (baseline.has(relativeFilename)) return;
        if (node.tag.type !== "Identifier" || node.tag.name !== "sql") return;
        for (const quasi of node.quasi.quasis) {
          const text = quasi.value.raw;
          sqlLiteral.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = sqlLiteral.exec(text))) {
            const value = match[1]?.replaceAll("\\'", "'");
            if (value !== undefined && vocabulary.has(value))
              context.report({
                node,
                messageId: "rawEnumLiteral",
                data: { value },
              });
          }
        }
      },
    };
  },
});
