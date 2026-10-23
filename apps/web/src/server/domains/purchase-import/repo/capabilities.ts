import { runEntityId } from "@cubby/schemas/identifiers";
import {
  agentImportRunPurpose,
  entityReadKinds,
  importRunAgentManifest,
  type ImportRunAgentConfig,
} from "@cubby/schemas/import-run-agent";
import type { CubbyMcpMutationAction } from "@cubby/schemas/mcp-tools";
import { runPurpose, type RunPurpose } from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";

import { type Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { run as runTable } from "~/server/db/retained-tables";

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
  ai_refresh: new Set(),
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
  mail_reclassify: new Set(),
  connection_discovery: new Set(),
  maintenance: new Set(),
  derived_refresh: new Set(),
  sweep: new Set(),
} satisfies Record<RunPurpose, ReadonlySet<Capability>>;

/**
 * The capability each MCP write action needs, keyed on `${tool}.${action}` so
 * authorizing one action of a tool never authorizes another
 * (`purchase_import.prepare` is `prepare`; `purchase_import.commit` is
 * `commit_purchase_import`). Exhaustive over the generated write actions: a
 * new one fails typecheck until it is classified here.
 */
const actionCapability = {
  "activity.delete_unused": "member_decision",
  "activity.resolve_arrived_findings": "member_decision",
  "entity.create": "generic_mutation",
  "entity.update": "generic_mutation",
  "entity.delete": "generic_mutation",
  "entity.merge": "generic_mutation",
  "entity.bulkUpdate": "generic_mutation",
  "entity.link": "generic_mutation",
  "entity.unlink": "generic_mutation",
  "entity.commands": "generic_mutation",
  "entity.resolve": "generic_mutation",
  "inventory.move_entries": "generic_mutation",
  "project_overview.repoint_uses": "generic_mutation",
  "inventory.reconcile_session": "member_decision",
  "inventory.resolve_scan_strays": "member_decision",
  "inventory.confirm_ownership": "member_decision",
  "ai.approve_detected_inventory_item": "member_decision",
  "ai.pause_suggestion_sweep": "member_decision",
  "ai.resume_suggestion_sweep": "member_decision",
  "ai.start_suggestion_sweep": "member_decision",
  "suggestions.review": "member_decision",
  "suggestions.review_batch": "member_decision",
  "suggestions.set_rule": "member_decision",
  "collection.create": "member_decision",
  "collection.set": "member_decision",
  "finance.commit_booking": "member_decision",
  "finance.commit_booking_correction": "member_decision",
  "finance.record": "generic_mutation",
  "purchase_import.mail_search": "prepare",
  "purchase_import.correct_email_relevance": "generic_mutation",
  "purchase_import.email_import": "start_run",
  "purchase_import.email_reclassify": "start_run",
  "purchase_import.email_preview_rerun": "start_run",
  "purchase_import.commit_accepted_reconciliation": "generic_mutation",
  "purchase_import.mail_resolve": "commit_purchase_import",
  "shipments.record": "commit_purchase_import",
  "shipments.associate": "member_decision",
  "shipments.reassign": "member_decision",
  "shipments.edit_observation": "member_decision",
  "shipments.merge": "member_decision",
  "purchase_import.email_purchase_decide": "member_decision",
  "purchase_import.prepare": "prepare",
  "purchase_import.prepare_reconciliation": "prepare",
  "purchase_import.commit": "commit_purchase_import",
  "purchase_import.confirm_merchant_vendor": "generic_mutation",
  "expenses.reclassify_document": "generic_mutation",
  "expenses.link": "generic_mutation",
  "expenses.split_with_delta": "generic_mutation",
  "expenses.confirm_inventory_beneficiary": "member_decision",
  "finance.converge": "business_writer",
  "finance.allocate_settlement": "member_decision",
  "finance.book_transaction": "member_decision",
  "finance.accept_transfer_pair": "member_decision",
  "product_enrichment.verify_images": "generic_mutation",
  "product_enrichment.propose_product_match": "match_proposal",
  "product_enrichment.merge_product_match": "member_decision",
  "product_enrichment.find_or_create_by_upc": "generic_mutation",
  "photo_run.propose_groups": "photo_commit",
  "photo_run.commit_group": "photo_commit",
  "photo_run.approve_groups": "member_decision",
  "photo_run.save_groups": "member_decision",
  "photo_run.choose_existing": "member_decision",
  "photo_run.update_draft": "member_decision",
  "photo_run.resolve_concern": "member_decision",
  "photo_run.reject_candidate": "member_decision",
  "photo_run.discard_group": "member_decision",
  "run.lifecycle": "start_run",
  "run.set_mail_import": "member_decision",
  "run.discover_mail": "member_decision",
  "run.sweep": "member_decision",
  "run.commit_prepared": "member_decision",
  "activity.resolve_run_finding": "member_decision",
  "ai_funding.set_credit_budget": "member_decision",
  "ai_funding.reset_credit_refusal": "member_decision",
  "nutrition.plan_recipe": "generic_mutation",
  "nutrition.update_recipe": "generic_mutation",
  "nutrition.remove_recipe": "generic_mutation",
  "nutrition.save_preparation": "generic_mutation",
  "recipe_insights.import_from_url": "generic_mutation",
  "recipe_insights.create_from_text": "generic_mutation",
  "recipe_insights.patch_line": "generic_mutation",
  "image.create_file_upload": "generic_mutation",
  "image.cull_pending_images": "member_decision",
  "image.retry": "member_decision",
  "image.attach_file": "attachment",
  "image.attach_existing": "attachment",
  "image.schedule": "attachment",
  "data_exception.set_exception": "generic_mutation",
  "data_exception.clear_exception": "generic_mutation",
  "imports.fetch_logo": "member_decision",
  "inventory.bulk_add": "member_decision",
  "inventory.bulk_discard": "member_decision",
  "inventory.receive_expense": "member_decision",
  "maintenance.backfill_image_search": "member_decision",
  "maintenance.classify_image_provenance": "member_decision",
  "maintenance.clear_uncertain_write": "member_decision",
  "maintenance.prune_orphaned_clients": "member_decision",
  "maintenance.repair_image_dimensions": "member_decision",
  "maintenance.run": "member_decision",
  "nutrition.copy_range": "member_decision",
  "nutrition.duplicate": "member_decision",
  "nutrition.remove_food": "member_decision",
  "nutrition.save_food": "member_decision",
  "product_enrichment.discard": "member_decision",
  "product_enrichment.find_or_create_by_code": "member_decision",
  "recipe_insights.delete_cookbook": "member_decision",
  "recipe_insights.recompute_one": "member_decision",
  "recipe_insights.reparse_line": "member_decision",
  "run.retry_step": "member_decision",
  "search.request_embedding_refresh": "member_decision",
  "spending_classification_write.apply": "generic_mutation",
  "ai.apply_finance_category_suggestion": "member_decision",
  "entity_graph.discover": "member_decision",
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
  const config: ImportRunAgentConfig | undefined = agentPurpose.success
    ? importRunAgentManifest[agentPurpose.data]
    : undefined;
  const allowed: readonly string[] = config?.mcpActions ?? [];
  return {
    purpose,
    allowed,
    entityRead: config?.entityRead,
    entityKinds: entityReadKinds(config?.entityRead),
  };
}

/**
 * Gate one trusted purchase-agent call: the run's purpose must mount the
 * action (`importRunAgentManifest[purpose].mcpActions`), and a write must also
 * hold its capability. Reads outside the manifest, and `entity_read` of a
 * kind outside `entityRead`, are refused too, so a mounted tool never
 * exposes more than the purpose lists.
 */
export async function assertPurchaseAgentAction(
  db: Database,
  runId: string,
  action: string,
  mutation: boolean,
  entity?: string,
): Promise<void> {
  const { purpose, allowed, entityKinds } = await purchaseAgentRunActions(
    db,
    runId,
  );
  if (!allowed.includes(action))
    throw new Error(
      `Import run purpose ${purpose} does not mount ${action}; its agent may call only ${allowed.join(", ") || "nothing"}`,
    );
  if (
    action.startsWith("entity_read.") &&
    entityKinds &&
    entity !== undefined &&
    !entityKinds.includes(entity)
  )
    throw new Error(
      `Import run purpose ${purpose} reads only ${entityKinds.join(", ")} through entity_read, not ${entity}`,
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
