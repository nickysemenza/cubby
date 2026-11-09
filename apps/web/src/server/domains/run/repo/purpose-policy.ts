import { runEntityId } from "@cubby/schemas/identifiers";
import { runPurpose, type RunPurpose } from "@cubby/schemas/run-fields";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db/database";
import { repositoryQueries as getDb } from "~/server/db/repository-access.boundary";
import { run as runTable } from "~/server/db/retained-tables";

export type RunCapability =
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

/**
 * Everything generic Run code needs to know about one purpose. Code outside
 * the owning domain reads these fields instead of comparing purpose literals.
 */
type RunPurposePolicy = {
  /** What a Run of this purpose may write; approval never widens it. */
  readonly capabilities: ReadonlySet<RunCapability>;
  /**
   * Who may pause, cancel, retry or restart it: only the member it belongs
   * to, or any household member (a shared photo Run).
   */
  readonly control: "owner" | "household";
  /**
   * Which retained Emails its import and shipment writers may read: only the
   * sources it admitted, any of its owner's retained mail, or none.
   */
  readonly mailSources: "admitted" | "owner" | null;
  /** A retry or restart successor stays under the same parent Run. */
  readonly successorKeepsParent: boolean;
};

const authorizesNothing: RunPurposePolicy = {
  capabilities: new Set(),
  control: "owner",
  mailSources: null,
  successorKeepsParent: false,
};

const RUN_PURPOSE_POLICY = {
  mail_import: {
    capabilities: new Set([
      "prepare",
      "commit_purchase_import",
      "business_writer",
      "finalize",
      "match_proposal",
    ]),
    control: "owner",
    mailSources: "admitted",
    successorKeepsParent: true,
  },
  photo_inventory: {
    capabilities: new Set([
      "photo_commit",
      "attachment",
      "generic_mutation",
      "finalize",
      "match_proposal",
    ]),
    control: "household",
    mailSources: null,
    successorKeepsParent: false,
  },
  // A member's own import (a receipt, an order Email, a vendor export).
  file_import: {
    capabilities: new Set([
      "prepare",
      "commit_purchase_import",
      "business_writer",
      "attachment",
      "finalize",
    ]),
    control: "owner",
    mailSources: "owner",
    successorKeepsParent: false,
  },
  // Retired purposes (ADR 0010) keep readable history and authorize nothing.
  account_sync: authorizesNothing,
  purchase_validation: authorizesNothing,
  product_enrichment: authorizesNothing,
  // Runs that only group AI work never authorize purchase-agent writes.
  ai_refresh: authorizesNothing,
  ai_suggest: authorizesNothing,
  background: authorizesNothing,
  mail_search: authorizesNothing,
  mail_discovery: authorizesNothing,
  mail_reclassify: authorizesNothing,
  connection_discovery: authorizesNothing,
  maintenance: authorizesNothing,
  derived_refresh: authorizesNothing,
  sweep: authorizesNothing,
} satisfies Record<RunPurpose, RunPurposePolicy>;

export const runPurposePolicy = (purpose: RunPurpose): RunPurposePolicy =>
  RUN_PURPOSE_POLICY[purpose];

export function runHasCapability(
  purpose: RunPurpose,
  capability: RunCapability,
): boolean {
  return runPurposePolicy(purpose).capabilities.has(capability);
}

export function assertRunCapability(
  purpose: RunPurpose,
  capability: RunCapability,
): void {
  if (runHasCapability(purpose, capability)) return;
  throw new Error(
    `Import run purpose ${purpose} forbids ${capability}; this cannot be overridden by approval`,
  );
}

export async function readRunPurpose(db: Database, runId: string) {
  const [run] = await getDb(db)
    .select({ purpose: runTable.purpose })
    .from(runTable)
    .where(eq(runTable.id, runEntityId.parse(runId)))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  return runPurpose.parse(run.purpose);
}

export async function assertRunCapabilityById(
  db: Database,
  runId: string,
  capability: RunCapability,
) {
  const purpose = await readRunPurpose(db, runId);
  assertRunCapability(purpose, capability);
  return purpose;
}
