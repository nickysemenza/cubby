import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import {
  fromManifest,
  parseSkillMarkdown,
  type SkillManifestEntry,
} from "agents/skills";
import photoWorkflow from "cubby/agent-skills/photo-inventory-import/references/run-workflow.md?raw";
import photoInventorySkill from "cubby/agent-skills/photo-inventory-import/SKILL.md?raw";
import productEnrichmentSkill from "cubby/agent-skills/product-enrichment/SKILL.md?raw";
import extractionRules from "cubby/agent-skills/purchase-import/references/extraction.md?raw";
import settlementRules from "cubby/agent-skills/purchase-import/references/financial-settlement.md?raw";
import mailImportWorkflow from "cubby/agent-skills/purchase-import/references/mail-import.md?raw";

import { skillReferences as references } from "./import-run-skill-references";

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

/**
 * Said only to a primary that can escalate (`escalation.ts`), so a Run
 * without an escalation model keeps its instructions and prompt cache.
 */
const ESCALATION_INSTRUCTIONS = `## Escalation

This Run can hand one Email at a time to a stronger escalation model. When an
Email's identity, attribution, meaning or amounts stay unclear after you have
read its evidence, call \`escalate_import_work\` with the reason instead of
guessing: the escalation model continues that Email and the next claim returns
to you. A refusal that names its next step is not such a gap: take that step
rather than repeating the refused call or escalating. Cubby also
escalates an Email whose \`purchase_import\` \`prepare\` refuses twice, and
holds an \`unresolved\` resolution until the escalation model has reviewed the
Email. An escalated Email is settled by the escalation model, including as
\`unresolved\` when the gap is real.`;

/** The run carries identity and tools; the workflow is shared Markdown. */
export function workflowForRun(
  purpose: AgentImportRunPurpose,
  runId: string,
  options: { escalation?: boolean } = {},
) {
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
    instructions: [
      // Writes that read `_runExecution` must name the delegated Run by its
      // private id; only those tools advertise the envelope to the agent
      // (`narrowedToolSchema`), so without this Pi could not form it.
      `This Mail import Run is (runId ${runId}). Every call to a tool whose input offers \`_runExecution\` carries \`_runExecution: { runId: "${runId}", operationId: <a stable id per call> }\`; \`commit\` names the \`prepare\` call's operationId.`,
      mailImportWorkflow,
      extractionRules,
      // Only the authority paragraph: the sign rules after it govern
      // finance_read previews, which this Run does not mount.
      settlementRules
        .split("## Authority and signs\n")[1]
        ?.split("Cubby signs are positive")[0] ?? "",
      ...(options.escalation ? [ESCALATION_INSTRUCTIONS] : []),
    ].join("\n\n"),
  };
}
