import type { AgentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import {
  fromManifest,
  parseSkill,
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
  const parsed = parseSkill(raw);
  if (!parsed.ok) {
    throw new Error(`Bundled skill failed to parse: ${parsed.error.message}`);
  }
  const skill = parsed.value;
  return {
    name: skill.name,
    description: skill.description,
    body: skill.body,
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata,
    allowedTools:
      skill.allowedTools.length > 0 ? skill.allowedTools.join(" ") : undefined,
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

You can ask a stronger model one question about the current Email with
\`escalate_import_work\`, classified as extraction, identity, contradiction, or
unclassified when you cannot classify it reliably. Ask only when stronger
reasoning over the Email could settle a specific fact; put that fact in
\`question\` and what you already established in \`facts\`. The answer comes
back to you: you keep this Email and make every write. Each Email may ask twice.
A missing original, a member-only decision, a source held by another Run or a
transient provider failure is not a reasoning problem: follow its owning
recovery policy or resolve this Email unresolved with the exact gap, then claim
the next. A schema refusal names its repair contract; correct it once instead
of repeating unchanged calls. An unresolved outcome or prepare refusal never
automatically asks a stronger model.
`;

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
