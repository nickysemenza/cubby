import { z } from "zod";

/** Tools folded into surviving ones; recorded calls keep their old names. */
const FOLDED_TOOLS = {
  usda_food: "product_enrichment_read",
  recipe_insights: "nutrition",
  recipe_insights_read: "nutrition_read",
  expenses: "finance",
  expenses_read: "finance_read",
  inventory: "entity",
  inventory_read: "entity_read",
  project_overview: "entity",
  project_overview_read: "entity_read",
  photo_run: "run",
  photo_run_read: "run_read",
  tasks_overview: "entity_read",
} as const;

const KERNEL_READS = new Set(["get", "list", "search"]);

const actionField = z.object({ action: z.string() });
const commandField = z.object({ command: actionField });

/**
 * The `tool.action` a recorded call ran. `input` is the call's arguments:
 * a current call carries its `action`, and the retired `entity`
 * tool carried its inside `command`. Names of tools retired before the
 * consolidation (no calls in 30 days) fall back to themselves.
 */
export function displayToolAction(toolName: string, input?: unknown): string {
  const recorded = toolName.split("__").at(-1) ?? toolName;
  const leaf = Object.hasOwn(FOLDED_TOOLS, recorded)
    ? // SAFETY: `Object.hasOwn` just proved `recorded` is one of the map's keys.
      FOLDED_TOOLS[recorded as keyof typeof FOLDED_TOOLS]
    : recorded;
  const command = commandField.safeParse(input).data?.command.action;
  if (leaf === "entity" && command)
    return KERNEL_READS.has(command)
      ? `entity_read.${command}`
      : `entity.${command === "attach" ? "link" : command === "detach" ? "unlink" : command}`;
  const action = actionField.safeParse(input).data?.action;
  return action ? `${leaf}.${action}` : leaf;
}
