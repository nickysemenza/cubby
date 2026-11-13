import type { ActorContext } from "@cubby/schemas/context";
import {convergeDuplicateSourceOrderInput,convergeDuplicateSourceOrderOut} from "@cubby/schemas/purchase-import";
import {parseEntityId} from "@cubby/schemas/identifiers";
import {and,eq,inArray} from "drizzle-orm";

import type {Database} from "~/server/db";
import {notDeleted} from "~/server/db/helpers";
import {recordKey} from "~/server/db/kernel-schema";
import {repositoryQueries} from "~/server/db/repository-access.boundary";
import {purchase} from "~/server/db/schema";
import {purchaseRecords} from "~/server/domains/financial-transaction/repo/purchase-event-records";
import {decide,householdWrite,merge,recordSubject,reconcileNow,resolveForRead} from "~/server/kernel/api";

/** An explicit same decision and survivor use the kernel's declared edge merge policy. */
export async function convergeDuplicateSourceOrder(db: Database,raw:{survivorPurchaseId:string;duplicatePurchaseId:string},actor:ActorContext) {
  const input=convergeDuplicateSourceOrderInput.parse(raw);
  return householdWrite(db,async database=> {
    const first=await resolveForRead(database,input.survivorPurchaseId),second=await resolveForRead(database,input.duplicatePurchaseId);
    if(first?.entity!=="purchase" || second?.entity!=="purchase") throw new Error("Review two live Purchases");
    if(first.id===second.id) return convergeDuplicateSourceOrderOut.parse({status:"already_applied",survivorPurchaseId:first.shortcode,retiredExpenseIds:[],movedSourceOrders:0});
    const q=repositoryQueries(database), rows=await q.select().from(purchase).where(and(inArray(purchase.id,[parseEntityId("purchase",first.id),parseEntityId("purchase",second.id)]),notDeleted(purchase)));
    if(rows.length!==2 || rows[0]!.vendorId!==rows[1]!.vendorId || !rows[0]!.orderId || rows[0]!.orderId!==rows[1]!.orderId) throw new Error("The orders do not identify the same seller and order");
    const records=await q.select().from(recordKey).where(and(eq(recordKey.entity,"purchase"),inArray(recordKey.entityId,[first.id,second.id])));
    const scopes=records.map(row=>({kind:row.scopeKind,key:row.scopeKey}));
    await decide(database,actor,[{channel:"identity",kind:"same",subject:recordSubject("purchase",first.id),field:recordSubject("purchase",second.id),scopes}]);
    const result=await merge(database,{target:purchaseRecords,a:first.id,b:second.id,basis:"decision",keepId:first.id,actor});
    if(!result.merged) throw new Error(`The orders cannot merge: ${result.reason}`);
    await reconcileNow(database,scopes);
    return convergeDuplicateSourceOrderOut.parse({status:"applied",survivorPurchaseId:first.shortcode,retiredExpenseIds:[],movedSourceOrders:0});
  });
}
