import type { ActorContext } from "@cubby/schemas/context";
import {
  type ProductId,
  runEntityId,
} from "@cubby/schemas/identifiers";
import {
  commitPurchaseImportInput,
  commitPurchaseImportOut,
  extractedPurchaseLine,
  importWriterInput,
  preparePurchaseImportInput,
  preparePurchaseImportOut,
  importOperationStatusInput,
  importOperationStatusOut,
  type CommitPurchaseImportInput,
  type PreparePurchaseImportInput,
  type PurchaseImportRunExecution,
} from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import type { Database } from "~/server/db";
import { productBrandNameSql } from "~/server/db/computed/product-brand-sql";
import {
  getDb,
  notDeleted,
} from "~/server/db/helpers";
import {
  product,
  purchase,
  sourceOrderObservation,
} from "~/server/db/schema";
import { amazonAsin } from "~/server/domains/product/repo/amazon-asin";
import {
  externalIdKey,
  findProductsByExternalIds,
  type ProductHit,
  type ExternalIdPair,
} from "~/server/domains/product/repo/find-by-external-ids";
import { productIdentityOverlap } from "~/server/domains/product/repo/match/product-identity-overlap";
import { resolveProductIdentifierSource } from "~/server/domains/product/repo/product-identifier-source";
import {
  findExactProductNameMatches,
  findProductIdentityReviewCandidates,
  findProductNameCandidates,
  PRODUCT_IDENTITY_REVIEW_REASON,
} from "~/server/domains/product/repo/resolve-names";
import {
  type ImportScope,
  loadImportScope,
  canonicalMailSourceKey,
  type RetainedMailSource,
  readUnchangedMailSource,
} from "~/server/domains/purchase-import/repo/import-scope";
import {
  MODEL_STYLE_MATCH_REASON,
  modelStyleTokens,
  sharesModelWithinManufacturer,
} from "~/server/domains/purchase-import/repo/manufacturer-identity";
import { sourceOrderKey } from "~/server/domains/purchase-import/repo/source-order-key";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import { executeAtomicOperation } from "~/server/domains/run/repo/operation";
import { assertRunCapability } from "~/server/domains/run/repo/purpose-policy";
import { readOperation } from "~/server/domains/run/repo/run-operation";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";

import {
  importVendorCandidates,
  resolveImportVendor,
} from "../repo/import-vendor";
import { lineIdentifierRequests } from "../repo/writer-decisions";


import {householdWrite, decide} from "~/server/kernel/api";
import {recordKey,evidenceBinding} from "~/server/db/kernel-schema";
import {appendOrderEvidence,orderEventKey,orderPaymentKeys} from "../repo/order-evidence";
import {settleOrderEvidence} from "../repo/settle-order-evidence";
async function importRunScope(
  db: Database,
  actor: ActorContext,
  execution: PurchaseImportRunExecution,
  open: boolean,
): Promise<ImportScope> {
  if (execution.runId)
    return loadImportScope(db, runEntityId.parse(execution.runId), actor);
  if (execution.run)
    return loadImportScope(
      db,
      await resolveOrThrow(db, "run", execution.run),
      actor,
    );
  if (!open)
    throw new Error(
      "Name the import Run (`run`) that this import's preparation returned.",
    );
  const runId = await ensureRun(db, actor, {
    purpose: "file_import",
    trigger: "manual",
    status: "running",
    clientKey: `purchase-import:${actor.userId}:${execution.operationId}`,
  });
  return loadImportScope(db, runId, actor);
}

async function preparedOrderVendor(
  db: Database,
  order: PreparePurchaseImportInput["orders"][number],
  scope: ImportScope,
  mail: RetainedMailSource | null | undefined,
  actor: ActorContext,
) {
  const seller = order.vendor
    ? {
        name: order.vendor.name,
        sender: mail?.sender ?? null,
        evidence: mail ? order.source.externalKey : null,
        distinctFrom: order.vendor.distinctFrom,
      }
    : null;
  const vendorCandidateRows = seller
    ? await importVendorCandidates(db, seller)
    : [];
  const vendorCandidates = vendorCandidateRows.map(
    ({ candidate }) => candidate,
  );
  const vendorId = order.vendorId
    ? await resolveOrThrow(db, "vendor", order.vendorId)
    : seller
      ? await resolveImportVendor(db, seller, actor, vendorCandidateRows)
      : scope.vendorId;
  if (!vendorId)
    throw new Error("Name each order's Vendor (vendorId or vendor.name).");
  // Resolution and this fence share the preparation transaction: a refused
  // Vendor rolls back, while Sender proof can still learn a valid alias.
  if (
    scope.purpose === "mail_import" &&
    scope.vendorId &&
    vendorId !== scope.vendorId
  )
    throw new Error("This Mail import is limited to its selected Vendor.");
  return { vendorId, vendorCandidates };
}

async function productCandidates(
  db: Database,
  requests: readonly ExternalIdPair[],
  exactHits: ReadonlyMap<string, ProductHit[]>,
  line: z.infer<typeof extractedPurchaseLine>,
) {
  const database = getDb(db);
  const exact = [
    ...new Map(
      requests
        .flatMap((request) => exactHits.get(externalIdKey(request)) ?? [])
        .map((hit) => [hit.id, hit]),
    ).values(),
  ];
  const fuzzy = await findProductNameCandidates(db, line.title);
  const review = await findProductIdentityReviewCandidates(db, line.title);
  const reviewIds = new Set(review.map(({ id }) => id));
  const exactProductIds = new Set(exact.map(({ id }) => id));
  const exactNameIds = new Set(
    (await findExactProductNameMatches(db, line.title)).map(({ id }) => id),
  );
  const modelTokens = modelStyleTokens(line.title).map((token) =>
    token.toLowerCase(),
  );
  const sharedModel = modelTokens.length
    ? await database
        .select({
          id: product.id,
          shortcode: product.shortcode,
          name: product.name,
          brandName: productBrandNameSql(product.brandId),
          model: product.model,
        })
        .from(product)
        .where(
          and(
            notDeleted(product),
            inArray(sql`lower(${product.model})`, modelTokens),
          ),
        )
        .limit(20)
    : [];
  // A shared model/style number only ranks: it never claims an exact variant.
  const modelRanked = sharedModel.filter(
    (hit) =>
      !exactProductIds.has(hit.id) &&
      sharesModelWithinManufacturer(line.title, hit),
  );
  const modelRankedIds = new Set(modelRanked.map(({ id }) => id));
  // Exact names rank right after exact identifiers: commit refuses a new
  // Product beside either without a Distinct-from decision.
  // Name lookup admits a single shared token; past exact names, a fuzzy hit
  // must also share the item's identity, its own brand counting only when the
  // line names it.
  const fuzzyRest = fuzzy.filter(
    (hit) =>
      !exactProductIds.has(hit.id) &&
      !modelRankedIds.has(hit.id) &&
      (exactNameIds.has(hit.id) ||
        productIdentityOverlap(
          {
            name: line.title,
            brandName:
              hit.brandName &&
              line.title.toLowerCase().includes(hit.brandName.toLowerCase())
                ? hit.brandName
                : null,
          },
          hit,
        ).relevant),
  );
  return [
    ...exact,
    ...fuzzyRest.filter(({ id }) => exactNameIds.has(id)),
    ...modelRanked,
    ...review.filter(
      ({ id }) =>
        !exactProductIds.has(id) &&
        !exactNameIds.has(id) &&
        !modelRankedIds.has(id),
    ),
    ...fuzzyRest.filter(
      ({ id }) => !exactNameIds.has(id) && !reviewIds.has(id),
    ),
  ]
    .slice(0, 20)
    .map(({ id, shortcode, ...candidate }) => ({
      productId: shortcode,
      ...candidate,
      exactIdentifierMatch: exactProductIds.has(id),
      exactNameMatch: exactNameIds.has(id),
      matchReason: modelRankedIds.has(id)
        ? MODEL_STYLE_MATCH_REASON
        : reviewIds.has(id)
          ? PRODUCT_IDENTITY_REVIEW_REASON
          : undefined,
    }));
}


/** The writer's own target fences, checked at prepare and again at commit. */

const acceptedPreparation = preparePurchaseImportOut.extend({
  acceptedOrders: z.array(z.object({stableOrderId: z.string(), observationId: z.uuid(), lineIds: z.array(z.string())})),
});

export async function preparePurchaseImport(db: Database, rawInput: PreparePurchaseImportInput,
  actor: ActorContext, _decisionPort?: DecisionPort) {
  const input = preparePurchaseImportInput.parse(rawInput);
  const scope = await importRunScope(db, actor, input._runExecution, true);
  assertRunCapability(scope.purpose, "prepare");
  return executeAtomicOperation(db, {runId:scope.runId, operationId:input._runExecution.operationId,
    kind:"prepare_purchase_import",payload:input.orders,subject:"Preparation"}, async ledger =>
    householdWrite(db, async database => {
      const replay = await ledger.replay(getDb(database), acceptedPreparation);
      if (replay) return preparePurchaseImportOut.parse(replay);
      if (["completed","cancelled","failed"].includes(scope.status)) throw new Error("Import Run is not active");
      const prepared = [];
      for (const order of input.orders) {
        const source = {...order.source, externalKey: await canonicalMailSourceKey(database,scope.ledgerPartyId,order.source)};
        const mail = await readUnchangedMailSource(database,scope,source,order.evidenceChecksum);
        const {vendorId,vendorCandidates} = await preparedOrderVendor(database,order,scope,mail,actor);
        const primaryDocumentImageId = order.primaryDocumentImageId ? await resolveOrThrow(database,"image",order.primaryDocumentImageId) : null;
        const screenshotImageId = order.screenshotImageId ? await resolveOrThrow(database,"image",order.screenshotImageId) : null;
        prepared.push({order,mail,vendorCandidates,input: importWriterInput.parse({runId:scope.runId,
          ledgerPartyId:scope.ledgerPartyId,vendorId,vendorAccountId:scope.vendorAccountId,source,
          extraction:order.extraction,primaryDocumentImageId,screenshotImageId})});
      }
      const observations = await appendOrderEvidence(database,prepared.map(({input,order,mail})=>({input,
        orderKey:sourceOrderKey({vendorId:input.vendorId,orderId:input.extraction.candidate?.orderId ?? null,orderLocator:order.stableOrderId}),
        emailId:mail?.emailId,lineIds:order.lineIds})));
      const outputOrders = [];
      const acceptedOrders = [];
      const decisions = [];
      for (const {order,input,vendorCandidates} of prepared) {
        const observation = [...observations].reverse().find(row=>row.checksum===input.source.checksum && row.sourceExternalKey===input.source.externalKey && row.vendorId===input.vendorId);
        if (!observation) throw new Error("Accepted extraction is missing");
        const target = order.targetPurchaseId ? await resolveOrThrow(database,"purchase",order.targetPurchaseId) : null;
        if (target) decisions.push({channel:"assignment" as const,kind:"set" as const,subject:orderEventKey(observation),field:"purchaseId",value:target,
          scopes:orderPaymentKeys(observation).map(key=>({kind:"paymentMatch",key}))});
        const lines = [];
        for (const [index,line] of (input.extraction.candidate?.lines ?? []).entries()) {
          const identifierSource = line.sku || amazonAsin(line.productUrl)
            ? await resolveProductIdentifierSource(database,{url:line.productUrl,vendorId:input.vendorId}) : "";
          const requests = lineIdentifierRequests(identifierSource,line);
          const hits = await findProductsByExternalIds(database,requests);
          lines.push({stableLineId:order.lineIds[index], title:line.title,amount:line.amount,
            identifiers:Object.fromEntries([...(line.sku?[["sku",line.sku]]:[]),...(line.productUrl?[["productUrl",line.productUrl]]:[])]),
            candidates:line.lineKind === "principal" ? await productCandidates(database,requests,hits,line) : [],
            requiresProductResolution:line.lineKind === "principal"});
        }
        outputOrders.push({stableOrderId:order.stableOrderId,itemOperationId:order.itemOperationId,source:input.source,
          orderId:input.extraction.candidate?.orderId ?? null, targetPurchaseId:order.targetPurchaseId ?? null,
          targetFingerprint:await sha256Hex(target ?? orderEventKey(observation)), evidenceFingerprint:observation.contentFingerprint,
          vendorCandidates,lines});
        acceptedOrders.push({stableOrderId:order.stableOrderId,observationId:observation.id,lineIds:order.lineIds});
      }
      if(decisions.length) await decide(database,actor,decisions);
      await settleOrderEvidence(database,observations);
      const result = acceptedPreparation.parse({runId:scope.shortcode,operationId:input._runExecution.operationId,
        status:"running",orders:outputOrders,acceptedOrders});
      await ledger.complete(getDb(database),result);
      return preparePurchaseImportOut.parse(result);
    }));
}

export async function commitPurchaseImport(db: Database,rawInput: CommitPurchaseImportInput,actor: ActorContext,
  _decisionPort?: DecisionPort, hooks?: {onProductsCreated?: (ids: ProductId[])=>Promise<void>}) {
  const input=commitPurchaseImportInput.parse(rawInput);
  const scope=await importRunScope(db,actor,input._runExecution,false);
  assertRunCapability(scope.purpose,"commit_purchase_import");
  return executeAtomicOperation(db,{runId:scope.runId,operationId:input._runExecution.operationId,
    kind:"commit_purchase_import",payload:input,subject:"Commit"}, async ledger=> householdWrite(db, async database=> {
      const replay=await ledger.replay(getDb(database),commitPurchaseImportOut); if(replay) return replay;
      const recorded=await readOperation(getDb(database),{runId:scope.runId,operationId:input.prepareOperationId});
      const preparation=acceptedPreparation.parse(recorded?.result);
      const observations=await getDb(database).select().from(sourceOrderObservation)
        .where(inArray(sourceOrderObservation.id,preparation.acceptedOrders.map(row=>row.observationId)));
      const decisions=[];
      const projectId=input.defaultProjectId ? await resolveOrThrow(database,"project",input.defaultProjectId) : undefined;
      for(const prepared of preparation.acceptedOrders) {
        const observation=observations.find(row=>row.id===prepared.observationId)!;
        const event=orderEventKey(observation);
        const scopes=[{kind:"purchaseEvent",key:event},...orderPaymentKeys(observation).map(key=>({kind:"paymentMatch",key}))];
        const subject=`purchaseEvent:${event}`;
        for(const [field,value] of Object.entries({defaultTrade:input.defaultTrade,defaultProjectId:projectId}))
          if(value !== undefined) decisions.push({channel:"assignment" as const,kind:"set" as const,subject,field,value,scopes});
        for(const choice of input.resolutions.filter(row=>row.stableOrderId===prepared.stableOrderId)) {
          const index=prepared.lineIds.indexOf(choice.stableLineId); if(index<0) throw new Error("Unknown prepared line");
          const resolution=choice.resolution;
          const value=resolution.kind === "existing" ? {...resolution,productId:await resolveOrThrow(database,"product",resolution.productId)} : resolution;
          decisions.push({channel:"assignment" as const,kind:"set" as const,subject,field:`line:${choice.stableLineId}`,value,scopes});
        }
      }
      await decide(database,actor,decisions);
      const outcomes=await settleOrderEvidence(database,observations);
      const records=await getDb(database).select().from(recordKey).where(and(eq(recordKey.scopeKind,"purchaseEvent"),eq(recordKey.entity,"purchase")));
      const purchases=await getDb(database).select({id:purchase.id,shortcode:purchase.shortcode}).from(purchase).where(notDeleted(purchase));
      const bindings=await getDb(database).select().from(evidenceBinding).where(and(eq(evidenceBinding.factKind,"orderObservation"),inArray(evidenceBinding.factId,observations.map(row=>row.id))));
      const items=preparation.acceptedOrders.map(prepared=> {
        const observation=observations.find(row=>row.id===prepared.observationId)!;
        const key=bindings.find(row=>row.factId===observation.id)?.eventKey ?? orderEventKey(observation);
        const owned=records.find(row=>row.scopeKey===key);
        const saved=purchases.find(row=>row.id===owned?.entityId);
        return {stableOrderId:prepared.stableOrderId,outcome:saved?"updated":"conflict",purchaseId:saved?.shortcode ?? null,
          findingCount:outcomes.filter(row=>row.scope.key===key).flatMap(row=>row.gaps).length};
      });
      const result=commitPurchaseImportOut.parse({runId:scope.shortcode,operationId:input._runExecution.operationId,status:"running",items});
      await ledger.complete(getDb(database),result);
      if(hooks?.onProductsCreated) {
        const created=await getDb(database).select({id:product.id}).from(product).innerJoin(recordKey,and(eq(recordKey.entityId,product.id),eq(recordKey.entity,"product"),inArray(recordKey.scopeKey,observations.map(orderEventKey))));
        if(created.length) await hooks.onProductsCreated(created.map(row=>row.id));
      }
      return result;
    }));
}
export async function purchaseImportOperationStatus(
  db: Database,
  rawInput: z.input<typeof importOperationStatusInput>,
  actor: ActorContext,
) {
  const input = importOperationStatusInput.parse(rawInput);
  const scope = await importRunScope(db, actor, input._runExecution, false);
  const operation = await readOperation(getDb(db), {
    runId: scope.runId,
    operationId: input._runExecution.operationId,
  });
  if (!operation) throw new Error("Purchase import operation was not found");
  return importOperationStatusOut.parse({
    runId: scope.shortcode,
    operationId: input._runExecution.operationId,
    kind: operation.kind,
    state: operation.state,
    result: operation.result,
    error: operation.error,
    startedAt: operation.startedAt.toISOString(),
    completedAt: operation.completedAt?.toISOString() ?? null,
  });
}
