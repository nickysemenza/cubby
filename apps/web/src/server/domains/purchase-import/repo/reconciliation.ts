import type { ActorContext } from "@cubby/schemas/context";
import type { PrepareSourceOrderReconciliationInput } from "@cubby/schemas/purchase-import";

import type { Database } from "~/server/db";
import {prepareAcceptedSourceOrderReconciliation} from "~/server/domains/purchase-import/repo/reconciliation-accepted";

/** Current accepted-order Product review uses the same decision writer as its source. */
export async function prepareSourceOrderReconciliation(db: Database,input: PrepareSourceOrderReconciliationInput,actor: ActorContext) {
  if(!("sourceOrderId" in input)) throw new Error("Review the accepted order's Product link through its current evidence gap");
  return prepareAcceptedSourceOrderReconciliation(db,input,actor);
}

/** Approving a source repair accepts a new immutable extraction, then dirties its existing event. */
export async function commitSourceOrderReconciliation(
  tx: import("~/server/db").DrizzleTransaction,
  fix: Extract<import("@cubby/schemas/purchase-import").ProposedImportFix,{kind:"reconcile_source_order"}>,
  actor: ActorContext,
  ownerId: import("@cubby/schemas/identifiers").LedgerPartyId,
) {
  const {and,eq}=await import("drizzle-orm");
  const {databaseForTransaction}=await import("~/server/db/helpers");
  const {sourceOrderObservation,purchase}=await import("~/server/db/schema");
  const {importWriterInput}=await import("@cubby/schemas/purchase-import");
  const {parseEntityId}=await import("@cubby/schemas/identifiers");
  const {appendOrderEvidence,orderEventKey}=await import("~/server/domains/purchase-import/repo/order-evidence");
  const {settleOrderEvidence}=await import("~/server/domains/purchase-import/repo/settle-order-evidence");
  const {decide}=await import("~/server/kernel/api");
  const observations=await tx.select().from(sourceOrderObservation).where(and(eq(sourceOrderObservation.orderKey,fix.orderKey),eq(sourceOrderObservation.ledgerPartyId,ownerId)));
  const prior=observations.at(-1);
  if(!prior || (fix.acceptedChecksum && prior.checksum!==fix.acceptedChecksum)) throw new Error("Accepted order changed after review");
  const [target]=await tx.select().from(purchase).where(eq(purchase.id,parseEntityId("purchase",fix.purchaseId)));
  if(!target) throw new Error("The reviewed Purchase is missing");
  const database=databaseForTransaction(tx);
  const accepted=await appendOrderEvidence(database,[{orderKey:fix.orderKey,emailId:prior.emailId,input:importWriterInput.parse({
    runId:prior.runId,ledgerPartyId:ownerId,vendorId:target.vendorId,vendorAccountId:target.vendorAccountId,
    source:fix.source,extraction:fix.proposedExtraction,primaryDocumentImageId:prior.primaryDocumentImageId,screenshotImageId:prior.screenshotImageId})}]);
  const head=accepted.at(-1);if(!head) throw new Error("The accepted repair is missing");
  const key=orderEventKey(head);
  await decide(database,actor,[{channel:"assignment",kind:"set",subject:key,field:"purchaseId",value:target.id,
    scopes:[{kind:"purchaseEvent",key}]}]);
  return settleOrderEvidence(database,[head]);
}
