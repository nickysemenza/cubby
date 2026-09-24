import type { FlueImportRunPurpose } from "@cubby/schemas/import-run-agent";

import photoInventorySkill from "../../../.claude/skills/photo-inventory-import/SKILL.md";
import photoWorkflow from "../../../.claude/skills/photo-inventory-import/references/run-workflow.md?raw";
import purchaseImportSkill from "../../../.claude/skills/purchase-import/SKILL.md";
import purchaseWorkflow from "../../../.claude/skills/purchase-import/references/run-workflow.md?raw";
import purchaseFinishNudge from "../../../.claude/skills/purchase-import/references/finish-nudge.md?raw";

/** Flue provides run identity and tools; the workflow is shared Markdown. */
export function workflowForImportRun(
  purpose: FlueImportRunPurpose,
  runId: string,
) {
  if (purpose === "photo_inventory") {
    return {
      skill: photoInventorySkill,
      finishNudge: null,
      instructions: photoWorkflow.replaceAll("{{runId}}", runId),
    };
  }
  return {
    skill: purchaseImportSkill,
    finishNudge: purchaseFinishNudge,
    instructions: purchaseWorkflow
      .replaceAll("{{runId}}", runId)
      .replaceAll("{{purpose}}", purpose),
  };
}
