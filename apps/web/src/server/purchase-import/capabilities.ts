import { runEntityId } from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  importRunAgentManifest,
} from "@cubby/schemas/import-run-agent";
import type { CubbyMcpMutationAction } from "@cubby/schemas/mcp-tools";
import { runPurpose, type RunPurpose } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { run as runTable } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

type Capability =
  | "prepare"
  | "commit_purchase_import"
  | "generic_mutation"
  | "attachment"
  | "business_writer"
  | "finalize"
  | "photo_commit"
  /** Review-queue metadata only: never changes household records. */
  | "match_proposal"
  /** Member Run lifecycle controls; no purpose may start or retry another Run. */
  | "start_run"
  /**
   * A member's own review, approval or paid grant; no Run purpose holds it,
   * so only a member session acting on the member's instruction calls these.
   */
  | "member_decision";

const capabilityMatrix = {
  mail_import: new Set([
    "prepare",
    "commit_purchase_import",
    "business_writer",
    "finalize",
    "match_proposal",
  ]),
  photo_inventory: new Set([
    "photo_commit",
    "attachment",
    "generic_mutation",
    "finalize",
    "match_proposal",
  ]),
  // Retired purposes (ADR 0010) keep readable history and authorize nothing.
  account_sync: new Set(),
  purchase_validation: new Set(),
  product_enrichment: new Set(),
  // Runs that only group AI work never authorize purchase-agent writes.
  ai_suggest: new Set(),
  suggestion_sweep: new Set(),
  background: new Set(),
  // A member's own import (a receipt, an order Email, a vendor export).
  file_import: new Set([
    "prepare",
    "commit_purchase_import",
    "business_writer",
    "attachment",
    "finalize",
  ]),
  mail_search: new Set(),
  mail_discovery: new Set(),
} satisfies Record<RunPurpose, ReadonlySet<Capability>>;

/**
 * The capability each MCP write action needs, keyed on `${tool}.${action}` so
 * authorizing one action of a tool never authorizes another
 * (`purchase_import.prepare` is `prepare`; `purchase_import.commit` is
 * `commit_purchase_import`). Exhaustive over the generated write actions: a
 * new one fails typecheck until it is classified here.
 */
const actionCapability = {
  "entity.create": "generic_mutation",
  "entity.update": "generic_mutation",
  "entity.delete": "generic_mutation",
  "entity.merge": "generic_mutation",
  "entity.bulkUpdate": "generic_mutation",
  "entity.link": "generic_mutation",
  "entity.unlink": "generic_mutation",
  "entity.commands": "generic_mutation",
  "entity.resolve": "generic_mutation",
  "entity.move_inventory": "generic_mutation",
  "entity.repoint_project_uses": "generic_mutation",
  "entity.reconcile_inventory": "member_decision",
  "entity.resolve_scan_strays": "member_decision",
  "entity.confirm_inventory_owner": "member_decision",
  "entity.approve_detected_item": "member_decision",
  "entity.accept_suggestion": "member_decision",
  "entity.accept_suggestions": "member_decision",
  "entity.reject_suggestion": "member_decision",
  "entity.record_suggestion_miss": "member_decision",
  "statement_rows.record": "generic_mutation",
  "statement_rows.update": "generic_mutation",
  "statement_rows.delete": "generic_mutation",
  "mail.search": "prepare",
  "mail.correct_relevance": "generic_mutation",
  "mail.accuracy_sample": "generic_mutation",
  "mail.accuracy_grade": "generic_mutation",
  "mail.import": "start_run",
  "mail.reclassify": "start_run",
  "mail.rerun_preview": "start_run",
  "purchase_import.commit_accepted_reconciliation": "generic_mutation",
  "mail.resolve": "commit_purchase_import",
  "mail.decide_purchase": "member_decision",
  "purchase_import.prepare": "prepare",
  "purchase_import.prepare_reconciliation": "prepare",
  "purchase_import.commit": "commit_purchase_import",
  "purchase_import.confirm_vendor": "generic_mutation",
  "purchase_import.reclassify": "generic_mutation",
  "expenses.link_to_purchase": "generic_mutation",
  "expenses.split": "generic_mutation",
  "expenses.confirm_beneficiary": "member_decision",
  "product_enrichment.verify_images": "generic_mutation",
  "product_enrichment.propose_match": "match_proposal",
  "product_enrichment.merge_match": "member_decision",
  "product_enrichment.dismiss_match": "member_decision",
  "product_enrichment.dismiss_duplicate": "member_decision",
  "product_enrichment.dismiss_related": "member_decision",
  "product_enrichment.dismiss_tag": "member_decision",
  "upc.find_or_create": "generic_mutation",
  "photo_run.propose_groups": "photo_commit",
  "photo_run.commit_group": "photo_commit",
  "photo_run.approve_groups": "member_decision",
  "photo_run.save_groups": "member_decision",
  "photo_run.choose_existing": "member_decision",
  "photo_run.update_draft": "member_decision",
  "photo_run.discard_group": "member_decision",
  "run.lifecycle": "start_run",
  "run.approve_execution": "member_decision",
  "run.discover_mail": "member_decision",
  "run.commit_prepared": "member_decision",
  "run.resolve_finding": "member_decision",
  "meal_recipe.add": "generic_mutation",
  "meal_recipe.update": "generic_mutation",
  "meal_recipe.remove": "generic_mutation",
  "meal_recipe.save_preparation": "generic_mutation",
  "recipe_import.import": "generic_mutation",
  "recipe_import.from_text": "generic_mutation",
  "recipe_import.patch_line": "generic_mutation",
  "image.create_uploads": "generic_mutation",
  "image.attach_files": "attachment",
  "image.attach_existing": "attachment",
  "image.correct_description": "attachment",
  "image.schedule_processing": "attachment",
  "data_exception.set": "generic_mutation",
  "data_exception.clear": "generic_mutation",
  "spending_classification_write.apply": "generic_mutation",
  "spending_classification_write.apply_category_suggestion": "member_decision",
} as const satisfies Record<CubbyMcpMutationAction, Capability>;

const isMutationAction = (action: string): action is CubbyMcpMutationAction =>
  Object.hasOwn(actionCapability, action);

export function capabilityForPurchaseAgentAction(
  action: CubbyMcpMutationAction,
): Capability {
  return actionCapability[action];
}

/** The MCP actions a run's purpose mounts; none for a purpose without an agent. */
export async function purchaseAgentRunActions(db: Database, runId: string) {
  const [run] = await getDb(db)
    .select({ purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  const purpose = runPurpose.parse(run.purpose);
  const agentPurpose = agentImportRunPurpose.safeParse(purpose);
  const allowed: readonly string[] = agentPurpose.success
    ? importRunAgentManifest[agentPurpose.data].mcpActions
    : [];
  return { purpose, allowed };
}

/**
 * Gate one trusted purchase-agent call: the run's purpose must mount the
 * action (`importRunAgentManifest[purpose].mcpActions`), and a write must also
 * hold its capability. Reads outside the manifest are refused too, so a
 * mounted tool never exposes more than the purpose lists.
 */
export async function assertPurchaseAgentAction(
  db: Database,
  runId: string,
  action: string,
  mutation: boolean,
): Promise<void> {
  const { purpose, allowed } = await purchaseAgentRunActions(db, runId);
  if (!allowed.includes(action))
    throw new Error(
      `Import run purpose ${purpose} does not mount ${action}; its agent may call only ${allowed.join(", ") || "nothing"}`,
    );
  if (!mutation) return;
  if (!isMutationAction(action))
    throw new Error(`${action} is not a registered MCP write action`);
  assertRunCapability(purpose, capabilityForPurchaseAgentAction(action));
}

export function runHasCapability(
  purpose: RunPurpose,
  capability: Capability,
): boolean {
  const allowed: ReadonlySet<Capability> = capabilityMatrix[purpose];
  return allowed.has(capability);
}

export function assertRunCapability(
  purpose: RunPurpose,
  capability: Capability,
): void {
  if (runHasCapability(purpose, capability)) return;
  throw new Error(
    `Import run purpose ${purpose} forbids ${capability}; this cannot be overridden by approval`,
  );
}

export async function assertRunCapabilityById(
  db: Database,
  runId: string,
  capability: Capability,
) {
  const [run] = await getDb(db)
    .select({ purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  const purpose = runPurpose.parse(run.purpose);
  assertRunCapability(purpose, capability);
  return purpose;
}
