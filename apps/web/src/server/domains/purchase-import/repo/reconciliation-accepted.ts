import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import {
  commitAcceptedSourceOrderReconciliationInput,
  commitAcceptedSourceOrderReconciliationOut,
  prepareSourceOrderReconciliationOut,
  type CommitAcceptedSourceOrderReconciliationInput,
  type PrepareSourceOrderReconciliationInput,
} from "@cubby/schemas/purchase-import";
import { minorToMoney } from "@cubby/shared";
import { and, eq } from "drizzle-orm";

import type { Database } from "~/server/db";
import { notDeleted } from "~/server/db/helpers";
import { evidenceBinding,recordKey } from "~/server/db/kernel-schema";
import { repositoryQueries } from "~/server/db/repository-access.boundary";
import { expense,ledgerParty,purchase,sourceOrderObservation } from "~/server/db/schema";
import { updatePurchaseEventWhere } from "~/server/domains/financial-transaction/repo/purchase-event-mutations";
import { orderEventKey } from "~/server/domains/purchase-import/policy/payment-keys";
import { sameLineTitle } from "~/server/domains/purchase-import/policy/import-lines";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import { decide,householdWrite,reconcileNow } from "~/server/kernel/api";
import { sha256CanonicalJson,jsonSnapshot } from "~/server/lib/canonical-json";

type Resolution = CommitAcceptedSourceOrderReconciliationInput["resolution"];
async function acceptedState(db: Database,id: string,actor: ActorContext,resolution: Resolution) {
  const q=repositoryQueries(db);
  const [owned]=await q.select({observation:sourceOrderObservation}).from(sourceOrderObservation)
    .innerJoin(ledgerParty,and(eq(ledgerParty.id,sourceOrderObservation.ledgerPartyId),eq(ledgerParty.userId,actor.userId),notDeleted(ledgerParty)))
    .where(eq(sourceOrderObservation.id,id));
  if(!owned) throw new Error("Accepted order not found for this member");
  const fact=owned.observation;
  const bindings=await q.select().from(evidenceBinding).where(and(eq(evidenceBinding.factKind,"orderObservation"),eq(evidenceBinding.factId,id)));
  const scope=bindings[0]?.eventKey ?? orderEventKey(fact);
  const records=await q.select().from(recordKey).where(and(eq(recordKey.scopeKind,"purchaseEvent"),eq(recordKey.scopeKey,scope),eq(recordKey.entity,"purchase")));
  const purchaseId=records[0]?.entityId ?? fact.purchaseId;
  if(!purchaseId) throw new Error("The order is waiting for its purchase identity");
  const [target]=await q.select().from(purchase).where(and(eq(purchase.id,parseEntityId("purchase",purchaseId)),notDeleted(purchase)));
  if(!target) throw new Error("The accepted Purchase is not live");
  const expenses=await q.select().from(expense).where(and(eq(expense.purchaseId,target.id),notDeleted(expense)));
  for(const binding of resolution.lines) {
    const line=fact.extraction.candidate?.lines[binding.lineIndex];
    const selected=expenses.find(row=>row.shortcode===binding.expenseId);
    if(!line || !selected || !sameLineTitle(line.title,selected.name)) throw new Error("Review the exact accepted item Expense before linking a Product");
    if(binding.productId && binding.newProduct) throw new Error("Choose one Product identity");
  }
  return {fact,scope,target,expenses};
}

/** Product review reads the accepted extraction and current records, never a second prepared ledger. */
export async function prepareAcceptedSourceOrderReconciliation(db: Database,input: Extract<PrepareSourceOrderReconciliationInput,{sourceOrderId:string}>,actor: ActorContext) {
  const state=await acceptedState(db,input.sourceOrderId,actor,input.resolution);
  const total=state.expenses.reduce((sum,row)=>sum+(row.cost ?? 0n),0n);
  return prepareSourceOrderReconciliationOut.options[1].parse({sourceOrderId:input.sourceOrderId,
    reviewedFingerprint:await sha256CanonicalJson(jsonSnapshot.parse(state)), resolution:input.resolution,
    source:{kind:state.fact.sourceKind,externalKey:state.fact.sourceExternalKey,checksum:state.fact.checksum},orderKey:state.fact.orderKey,
    accepted:{checksum:state.fact.checksum,extraction:state.fact.extraction},proposed:{checksum:state.fact.checksum,extraction:state.fact.extraction},
    spend:{before:minorToMoney(total),after:minorToMoney(total),delta:0},expenses:state.expenses.map(row=>({id:row.shortcode,title:row.name,amount:row.cost===null?null:minorToMoney(row.cost),productId:null})),
    payments:state.fact.extraction.candidate?.payments ?? [], proposedPayments:[],allocationTotal:0,allocations:[],originalAttributions:[],attributions:[]});
}

/** The existing line's Product override is a durable member decision; its money stays accepted. */
export async function commitAcceptedSourceOrderReconciliation(db: Database,raw: CommitAcceptedSourceOrderReconciliationInput,actor: ActorContext) {
  const input=commitAcceptedSourceOrderReconciliationInput.parse(raw);
  return householdWrite(db,async database=> {
    const state=await acceptedState(database,input.sourceOrderId,actor,input.resolution);
    let changed=false;
    for(const binding of input.resolution.lines) {
      const selected=state.expenses.find(row=>row.shortcode===binding.expenseId)!;
      if(binding.newProduct) {
        const line=state.fact.productBindings.find(row=>row.lineIndex===binding.lineIndex);
        await decide(database,actor,[{channel:"assignment",kind:"set",subject:`purchaseEvent:${state.scope}`,
          field:`line:${line?.stableLineId ?? binding.lineIndex}`,value:binding.newProduct,scopes:[{kind:"purchaseEvent",key:state.scope}]}]);
        changed=true;
      } else {
        const productId=binding.productId ? await resolveOrThrow(database,"product",binding.productId):null;
        if(productId===selected.productId) continue;
        await updatePurchaseEventWhere(database,"expense",{productId,productQuantity:productId?selected.productQuantity ?? 1:null},eq(expense.id,selected.id),actor);
        changed=true;
      }
    }
    await reconcileNow(database,[{kind:"purchaseEvent",key:state.scope}]);
    return commitAcceptedSourceOrderReconciliationOut.parse({purchaseId:parseShortcodeFor("purchase",state.target.shortcode),alreadyApplied:!changed});
  });
}
