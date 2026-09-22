import { purchaseImportRunId } from "@cubby/schemas/identifiers";
import {
  importRunPurpose,
  type ImportRunPurpose,
} from "@cubby/schemas/purchase-import";
import { eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { importRun } from "~/server/db/schema";
import { getDb } from "~/server/repo/database-helpers";

type Capability =
  | "prepare"
  | "commit_purchase_import"
  | "generic_mutation"
  | "attachment"
  | "audit_repair"
  | "business_writer"
  | "evidence"
  | "browser"
  | "finalize"
  | "enrichment_commit";

const capabilityMatrix = {
  account_sync: new Set([
    "prepare",
    "commit_purchase_import",
    "generic_mutation",
    "attachment",
    "audit_repair",
    "business_writer",
    "evidence",
    "browser",
    "finalize",
  ]),
  purchase_validation: new Set(["prepare", "evidence", "browser", "finalize"]),
  product_enrichment: new Set([
    "prepare",
    "evidence",
    "browser",
    "finalize",
    "enrichment_commit",
  ]),
} satisfies Record<ImportRunPurpose, ReadonlySet<Capability>>;

export function capabilityForPurchaseAgentTool(
  toolName: string,
  mutation: boolean,
): Capability | null {
  if (!mutation) return null;
  if (toolName === "prepare_purchase_import") return "prepare";
  if (toolName === "validate_purchase_import") return "prepare";
  if (toolName === "commit_product_enrichment") return "enrichment_commit";
  if (toolName === "overwrite_product_enrichment") return "enrichment_commit";
  if (toolName === "commit_purchase_import") return "commit_purchase_import";
  if (toolName.includes("audit") || toolName.includes("repair"))
    return "audit_repair";
  if (toolName.includes("attach") || toolName.includes("image"))
    return "attachment";
  return "generic_mutation";
}

export function assertImportRunCapability(
  purpose: ImportRunPurpose,
  capability: Capability,
): void {
  const allowed: ReadonlySet<Capability> = capabilityMatrix[purpose];
  if (allowed.has(capability)) return;
  throw new Error(
    `Import run purpose ${purpose} forbids ${capability}; this cannot be overridden by approval`,
  );
}

export async function assertImportRunCapabilityById(
  db: Database,
  runId: string,
  capability: Capability,
) {
  const [run] = await getDb(db)
    .select({ purpose: importRun.purpose })
    .from(importRun)
    .where(eq(importRun.id, purchaseImportRunId.parse(runId)))
    .limit(1);
  if (!run) throw new Error("Import run was not found");
  const purpose = importRunPurpose.parse(run.purpose);
  assertImportRunCapability(purpose, capability);
  return purpose;
}
