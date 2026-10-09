import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import {
  fromManifest,
  parseSkillMarkdown,
  type SkillManifestEntry,
} from "agents/skills";

import photoWorkflow from "../../../../../.claude/skills/photo-inventory-import/references/run-workflow.md?raw";
import photoInventorySkill from "../../../../../.claude/skills/photo-inventory-import/SKILL.md?raw";
import enrichmentWorkflow from "../../../../../.claude/skills/product-enrichment/references/research-run-workflow.md?raw";
import productEnrichmentSkill from "../../../../../.claude/skills/product-enrichment/SKILL.md?raw";
import extractionRules from "../../../../../.claude/skills/purchase-import/references/extraction.md?raw";
import settlementRules from "../../../../../.claude/skills/purchase-import/references/financial-settlement.md?raw";
import purchaseWorkflow from "../../../../../.claude/skills/purchase-import/references/research-run-workflow.md?raw";

const references = {
  "photo-inventory-import": import.meta.glob<string>(
    "../../../../../.claude/skills/photo-inventory-import/references/*.md",
    { query: "?raw", import: "default", eager: true },
  ),
  "product-enrichment": import.meta.glob<string>(
    "../../../../../.claude/skills/product-enrichment/references/*.md",
    { query: "?raw", import: "default", eager: true },
  ),
};

/** One repository skill with its `references/*.md` as readable resources. */
function skillEntry(
  raw: string,
  files: Record<string, string>,
): SkillManifestEntry {
  const parsed = parseSkillMarkdown(raw);
  if (!parsed) throw new Error("Bundled skill has no frontmatter");
  return {
    ...parsed,
    resources: Object.entries(files).map(([file, content]) => ({
      path: `references/${file.slice(file.lastIndexOf("/") + 1)}`,
      kind: "reference",
      content,
    })),
  };
}

const fromBundle = (id: string, skills: SkillManifestEntry[]) =>
  fromManifest({
    id,
    fingerprint: `${id}:${skills.map((skill) => skill.name).join(",")}`,
    skills,
  });

/** The run carries identity and tools; the workflow is shared Markdown. */
export function workflowForRun(purpose: AgentImportRunPurpose, runId: string) {
  const enrichment = skillEntry(
    productEnrichmentSkill,
    references["product-enrichment"],
  );
  if (purpose === "photo_inventory") {
    return {
      skills: fromBundle("cubby-photo-inventory", [
        skillEntry(photoInventorySkill, references["photo-inventory-import"]),
        enrichment,
      ]),
      instructions: photoWorkflow.replaceAll("{{runId}}", runId),
    };
  }
  return {
    skills: null,
    instructions:
      purpose === "product_enrichment"
        ? enrichmentWorkflow
        : [
            purchaseWorkflow,
            extractionRules,
            settlementRules
              .split("## Authority and signs\n")[1]
              ?.split("**Verify the normalization")[0] ?? "",
          ].join("\n\n"),
  };
}
