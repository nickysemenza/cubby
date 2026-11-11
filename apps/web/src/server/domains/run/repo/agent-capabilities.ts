import {
  agentImportRunPurpose,
  entityReadKinds,
  importRunAgentManifest,
  type ImportRunAgentConfig,
} from "@cubby/schemas/import-run-agent";
import type { CubbyMcpMutationAction } from "@cubby/schemas/mcp-tools";

import { type Database } from "~/server/db/database";

import {
  assertRunCapability,
  readRunPurpose,
  type RunCapability,
} from "./purpose-policy";

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
  "entity.move_entries": "generic_mutation",
  "entity.repoint_uses": "generic_mutation",
  "entity.reconcile_session": "member_decision",
  "entity.resolve_scan_strays": "member_decision",
  "entity.confirm_ownership": "member_decision",
  "ai.approve_detected_inventory_item": "member_decision",
  "ai.stop_automatic_work": "member_decision",
  "ai.resume_automatic_work": "member_decision",
  "image.confirm_description": "member_decision",
  "suggestions.review": "member_decision",
  "suggestions.field_authority": "member_decision",
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
  "purchase_import.converge_duplicate_source_order": "member_decision",
  "purchase_import.prepare": "prepare",
  "purchase_import.prepare_reconciliation": "prepare",
  "purchase_import.commit": "commit_purchase_import",
  "finance.reclassify_document": "generic_mutation",
  "finance.link": "generic_mutation",
  "finance.split_with_delta": "generic_mutation",
  "finance.confirm_inventory_beneficiary": "member_decision",
  "finance.converge": "business_writer",
  "finance.allocate_settlement": "member_decision",
  "finance.book_transaction": "member_decision",
  "finance.accept_transfer_pair": "member_decision",
  "product_enrichment.verify_images": "generic_mutation",
  "product_enrichment.propose_product_match": "match_proposal",
  "product_enrichment.find_or_create_by_upc": "generic_mutation",
  "run.propose_groups": "photo_commit",
  "run.commit_group": "photo_commit",
  "run.approve_groups": "member_decision",
  "run.save_groups": "member_decision",
  "run.choose_existing": "member_decision",
  "run.update_draft": "member_decision",
  "run.resolve_concern": "member_decision",
  "run.reject_candidate": "member_decision",
  "run.discard_group": "member_decision",
  "run.lifecycle": "start_run",
  "run.set_mail_import": "member_decision",
  "run.discover_mail": "member_decision",
  "run.controlled_mail_import": "member_decision",
  "run.resume_controlled_mail_import": "member_decision",
  "run.sweep": "member_decision",
  "run.commit_prepared": "member_decision",
  "activity.resolve_run_finding": "member_decision",
  "ai_funding.set_budget": "member_decision",
  "ai_funding.reset_funding_refusal": "member_decision",
  "nutrition.plan_recipe": "generic_mutation",
  "nutrition.update_recipe": "generic_mutation",
  "nutrition.remove_recipe": "generic_mutation",
  "nutrition.save_preparation": "generic_mutation",
  "nutrition.import_from_url": "generic_mutation",
  "nutrition.create_from_text": "generic_mutation",
  "nutrition.patch_line": "generic_mutation",
  "image.create_file_upload": "generic_mutation",
  "image.cull_pending_images": "member_decision",
  "image.retry": "member_decision",
  "image.attach_file": "attachment",
  "image.attach_existing": "attachment",
  "image.schedule": "attachment",
  "data_exception.set_exception": "generic_mutation",
  "data_exception.clear_exception": "generic_mutation",
  "imports.fetch_logo": "member_decision",
  "entity.bulk_add": "member_decision",
  "entity.bulk_discard": "member_decision",
  "entity.receive_expense": "member_decision",
  "maintenance.backfill_image_search": "member_decision",
  "maintenance.classify_image_provenance": "member_decision",
  "maintenance.clear_uncertain_write": "member_decision",
  "maintenance.prune_orphaned_clients": "member_decision",
  "maintenance.repair_image_dimensions": "member_decision",
  "maintenance.run": "member_decision",
  "maintenance.rebuild_derived": "member_decision",
  "maintenance.retry_now": "member_decision",
  "nutrition.copy_range": "member_decision",
  "nutrition.duplicate": "member_decision",
  "nutrition.remove_food": "member_decision",
  "nutrition.save_food": "member_decision",
  "product_enrichment.discard": "member_decision",
  "product_enrichment.find_or_create_by_code": "member_decision",
  "nutrition.delete_cookbook": "member_decision",
  "nutrition.recompute_one": "member_decision",
  "nutrition.reparse_line": "member_decision",
  "run.retry_step": "member_decision",
  "search.request_embedding_refresh": "member_decision",
  "spending_classification_write.apply": "generic_mutation",
  "ai.apply_finance_category_suggestion": "member_decision",
  "entity_graph.discover": "member_decision",
} as const satisfies Record<CubbyMcpMutationAction, RunCapability>;

const isMutationAction = (action: string): action is CubbyMcpMutationAction =>
  Object.hasOwn(actionCapability, action);

export function capabilityForPurchaseAgentAction(
  action: CubbyMcpMutationAction,
): RunCapability {
  return actionCapability[action];
}

/** The MCP actions a run's purpose mounts; none for a purpose without an agent. */
export async function purchaseAgentRunActions(db: Database, runId: string) {
  const purpose = await readRunPurpose(db, runId);
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
