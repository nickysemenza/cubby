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
          "tools/oxlint/cubby/no-raw-deleted-at-predicate-baseline.json",
        ),
        "utf8",
      ),
    ),
  );

// Raw liveness spelled in SQL text: template quasis and plain strings (the
// retired raw-string correlation helpers hid predicates in plain strings).
const rawPredicate = /"deletedAt"\s+IS\s+NULL/gi;

const count = (text: string) => text.match(rawPredicate)?.length ?? 0;

export const noRawDeletedAtPredicateRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow new hand-written `"deletedAt" IS NULL` predicates; related() and notDeleted() own liveness.',
    },
    messages: {
      rawPredicate:
        'This file spells `"deletedAt" IS NULL` {{actual}} times, above its baseline of {{allowed}}. Read live rows through related() (server/db/helpers/related.ts) or notDeleted() instead.',
      staleBaseline:
        'This file spells `"deletedAt" IS NULL` {{actual}} times, below its baseline of {{allowed}}; lower the baseline.',
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
    const note = (node: ESTree.Node, text: string) => {
      const found = count(text);
      if (found === 0) return;
      total += found;
      first ??= node;
    };
    return {
      Program(node) {
        program = node;
      },
      TemplateElement(node) {
        note(node, node.value.raw);
      },
      Literal(node) {
        if (typeof node.value === "string") note(node, node.value);
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
            messageId: "rawPredicate",
            data: { actual: total, allowed },
          });
      },
    };
  },
});
