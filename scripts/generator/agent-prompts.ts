import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { generatedHeader } from "./artifacts.ts";
import type { EntityArtifacts } from "./entities/declarations.ts";

const sources = {
  extraction: ".claude/skills/purchase-import/references/extraction.md",
  extractionOutput:
    ".claude/skills/purchase-import/references/extraction-output.md",
  audit: ".claude/skills/purchase-import/references/audit.md",
  receiptExtraction:
    ".claude/skills/purchase-import/references/receipt-extraction.md",
  orderMail: ".claude/skills/purchase-import/references/order-mail.md",
} as const;

/** Playwright imports server modules directly; generated text keeps Markdown authoritative there. */
export async function renderAgentPromptArtifact(
  root: string,
): Promise<EntityArtifacts> {
  const entries = await Promise.all(
    Object.entries(sources).map(
      async ([key, path]) =>
        [key, await readFile(resolve(root, path), "utf8")] as const,
    ),
  );
  return {
    relativePath:
      "apps/web/src/server/agents/purchase-import/prompt-text.gen.ts",
    source: `${generatedHeader}export const purchaseImportPromptText = ${JSON.stringify(Object.fromEntries(entries))} as const;\n`,
  };
}
