import { createHash } from "node:crypto";

import type { ActorContext } from "@cubby/schemas/context";
import { parseEntityId } from "@cubby/schemas/identifiers";
import {
  IMAGE_DESCRIPTION_PROMPT_REVISION,
  IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
} from "@cubby/schemas/image-processing";
import {
  commitPurchaseImportInput,
  preparePurchaseImportInput,
} from "@cubby/schemas/purchase-import";
import { retainedResearchObservation } from "@cubby/schemas/research";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { IMAGE_DESCRIPTION_FEATURE } from "~/server/ai/features";
import { providerFor } from "@cubby/shared/ai/models";
import type { Database } from "~/server/db";
import * as schema from "~/server/db/schema";
import { ingestGmailMessages } from "~/server/purchase-import/gmail/ingest";
import {
  commitPurchaseImport,
  preparePurchaseImport,
} from "~/server/purchase-import/import-orders";
import { resolveImportResearch } from "~/server/purchase-import/research-import";
import { startMailResearch } from "~/server/purchase-import/research-run";
import { researchServiceFor } from "~/server/purchase-import/research-service";
import { getDb } from "~/server/repo/database-helpers";
import { effectiveExpenseSpendingCategorySql } from "~/server/repo/expense-category-resolution";
import {
  claimImageProcessingJob,
  completeImageProcessingJob,
} from "~/server/repo/image-processing";
import { assignImageProcessingExecutor } from "~/server/repo/image-processing-history";
import { imageDescriptionInputFingerprint } from "~/server/services/image-description.service";

import type { CreatableEntity, EntityOverrides } from "./factories/build";

/**
 * The evidence-convergence scenario shared by its three drivers: the
 * PostgreSQL integration test (server writers called directly), the Playwright
 * spec (the same writers behind browser routes), and the native Mac import
 * journey. Each driver keeps only its transport glue; the synthetic world, the
 * Gmail/retailer/statement evidence, the image-description job completion and
 * the convergence projection live here.
 *
 * Only account, vendor, location and category prerequisites are fixtures.
 * Every economic record and observation enters through an import writer.
 */

/** Creates one fixture entity from a factory-built input; the transport differs per driver. */
export type CreateConvergenceFixture = <E extends CreatableEntity>(
  entity: E,
  overrides: EntityOverrides<E>,
) => Promise<{ id: string }>;

export interface ConvergenceNames {
  token: string;
  name: string;
  productName: string;
  orderId: string;
  host: string;
  sender: string;
  messageId: string;
  /** The statement account descriptor the CSV rows name. */
  statementAccount: string;
  retailerHtml: string;
  retailerCandidate: RetailerCandidate;
  statementCsv: string;
}

interface RetailerCandidate {
  orderId: string;
  orderedAt: string;
  merchant: string;
  currency: string;
  printedGrandTotal: number;
  lines: Array<{
    title: string;
    amount: number;
    lineKind: string;
    identifiers: { sku: string };
  }>;
  payments: never[];
  allShipmentsDelivered: boolean;
}

export function convergenceNames(token: string): ConvergenceNames {
  const name = `Synthetic evidence ${token}`;
  const productName = `${name} crew shirt`;
  const orderId = `SYN-ORDER-${token}`;
  const host = `shop-${token.toLowerCase()}.example.test`;
  return {
    token,
    name,
    productName,
    orderId,
    host,
    sender: `orders@${host}`,
    messageId: `synthetic-message-${token}`,
    statementAccount: `${name} Visa`,
    retailerHtml: `<main><h1>${orderId}</h1><p data-total="42.50">USD 42.50</p><p data-item="${productName}" data-sku="SYN-SKU-${token}">${productName}</p></main>`,
    retailerCandidate: {
      orderId,
      orderedAt: "2026-09-10T12:00:00.000Z",
      merchant: name,
      currency: "USD",
      printedGrandTotal: 42.5,
      lines: [
        {
          title: productName,
          amount: 42.5,
          lineKind: "principal",
          identifiers: { sku: `SYN-SKU-${token}` },
        },
      ],
      payments: [],
      allShipmentsDelivered: true,
    },
    statementCsv: `Date,Merchant,Category,Account,Original Statement,Notes,Amount,Id\n2026-09-12,${name},Clothing,${name} Visa,SYNTHETIC ORDER ${token},,-42.50,${token}-posted`,
  };
}

/** Vendor, retailer account, card, drawer and category prerequisites. */
export async function createConvergenceFixtures(
  create: CreateConvergenceFixture,
  memberShortcode: string,
  names: ConvergenceNames,
) {
  const { name, host, sender } = names;
  const vendor = await create("vendor", {
    name,
    website: `https://${host}`,
    browserDomains: [host],
    orderEmailSenders: [sender],
    orderEvidence: "online_account",
  });
  const account = await create("vendorAccount", {
    label: `${name} retailer`,
    vendorId: vendor.id,
    ledgerPartyId: memberShortcode,
  });
  const card = await create("financialAccount", {
    name: `${name} card`,
    identity: { kind: "credit_card", issuer: null, network: "visa" },
    ledgerPartyId: memberShortcode,
    sourceAliases: [
      {
        source: "monarch",
        alias: names.statementAccount,
        externalAccountId: null,
      },
    ],
  });
  const location = await create("location", {
    name: `${name} drawer`,
    type: "drawer",
  });
  const category = await create("spendingCategory", {
    name: `${name} clothing`,
    evidenceExpectation: "required",
    productExpectation: "required",
  });
  const productCategory = await create("productCategory", {
    name: `${name} apparel`,
    spendingCategoryMode: "mapped",
    spendingCategoryId: category.id,
  });
  return { vendor, account, card, location, category, productCategory };
}

/**
 * Acquire and admit the original through production services. The returned
 * researcher turn runs after the other sources arrive, modeling delayed
 * background execution rather than a member link or invented itemization.
 */
export async function ingestGmailEvidence(
  db: Database,
  ledgerPartyId: string,
  names: ConvergenceNames,
) {
  const { token, orderId, sender, messageId } = names;
  const message = {
    id: messageId,
    threadId: `synthetic-thread-${token}`,
    historyId: "1",
    internalDate: String(Date.parse("2026-09-10T12:30:00Z")),
    payload: {
      mimeType: "text/plain",
      headers: [
        { name: "From", value: sender },
        { name: "Subject", value: `Order ${orderId}` },
      ],
      body: {
        data: Buffer.from(`Order ${orderId} placed. Total USD 42.50.`).toString(
          "base64url",
        ),
      },
    },
  };
  // A provider that serves exactly this message, through the real ingestion.
  const { orderMailIds } = await ingestGmailMessages(
    db,
    {
      getProfile: async () => ({ historyId: "1" }),
      listMessages: async () => ({ messages: [{ id: messageId }] }),
      getMessage: async () => message,
      listHistory: async () => ({ historyId: "1" }),
      getAttachment: async () => ({}),
    },
    {
      ledgerPartyId,
      mailboxId: `synthetic-mailbox-${token}`,
      messageIds: [messageId],
      triage: async () => "related",
    },
  );
  const [member] = await getDb(db)
    .select({ userId: schema.ledgerParty.userId })
    .from(schema.ledgerParty)
    .where(
      eq(schema.ledgerParty.id, parseEntityId("ledgerParty", ledgerPartyId)),
    );
  if (!member?.userId || orderMailIds.length !== 1)
    throw new Error("Synthetic retained mail or owning member missing");
  const [started] = await startMailResearch(
    db,
    { ledgerPartyId, userId: member.userId, messageIds: orderMailIds },
    { send: async () => {} },
  );
  if (!started) throw new Error("Synthetic mail research admission missing");
  const bytes = new Map<string, Uint8Array>();
  const services = researchServiceFor(
    db,
    fromPartial<Env>({ R2_KEY_PREFIX: "synthetic/convergence" }),
    started.runId,
    {
      observations: {
        storage: {
          put: async (key, data) => {
            bytes.set(key, data);
          },
          get: async (key) => {
            const data = bytes.get(key);
            if (!data) throw new Error("Synthetic retained original missing");
            return new TextDecoder().decode(data);
          },
        },
      },
      queue: { send: async () => {} },
    },
  );
  return async (purchaseRef: string) => {
    const next = z
      .object({ work: z.object({ workRef: z.uuid() }) })
      .parse(await services.researchNext({}, `synthetic-next-${token}`));
    const observed = retainedResearchObservation.parse(
      await services.researchMailRead(
        { workRef: next.work.workRef, messageRef: orderMailIds[0]! },
        `synthetic-read-${token}`,
      ),
    );
    const proposal = researchWorkResolve.parse({
      workRef: next.work.workRef,
      status: "verified",
      identity: {
        evidenceIds: [observed.evidenceId],
        reasoning: "The original names the retailer order and its exact total.",
      },
      emailLinks: [
        {
          purchaseRef,
          evidenceIds: [observed.evidenceId],
          event: "confirmation",
          reasoning:
            "The retained order ID, retailer and total uniquely match this Purchase.",
        },
      ],
      detail:
        "Linked the retained confirmation without changing itemization or settlement.",
    });
    const callId = `synthetic-resolve-${token}`;
    await resolveImportResearch(
      db,
      {
        runId: started.runId,
        workRef: next.work.workRef,
        callId,
        proposal,
      },
      {
        readEvidence: async (evidence) => {
          const data = bytes.get(evidence.objectKey);
          if (!data) throw new Error("Synthetic retained original missing");
          return new TextDecoder().decode(data);
        },
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedOrders: [],
          acceptedEmailLinks: [0],
          rejected: [],
        }),
      },
    );
    await services.researchResolve(proposal, callId);
  };
}

export interface BrowserOrderImport {
  runId: string;
  actor: ActorContext;
  /** Operation ids: `prepare`, `commit`, `order`, `line`, `item`. */
  ids: {
    prepare: string;
    commit: string;
    order: string;
    line: string;
    item: string;
  };
  externalKey: string;
  checksum: string;
  extractionRevision: string;
  candidate: unknown;
  /** The booked aggregate Purchase this receipt replaces, when the statement arrived first. */
  targetPurchaseId?: string;
  /** Runs between prepare and commit; returns the reviewed Product shortcode, if one exists. */
  resolveProduct: () => Promise<string | undefined>;
}

/** Prepare then commit one browser-captured retailer order through the production writers. */
export async function importBrowserOrder(
  db: Database,
  input: BrowserOrderImport,
) {
  const { ids } = input;
  await preparePurchaseImport(
    db,
    preparePurchaseImportInput.parse({
      _runExecution: {
        runId: input.runId,
        operationId: ids.prepare,
        itemOperationIds: [ids.item],
      },
      orders: [
        {
          targetPurchaseId: input.targetPurchaseId,
          stableOrderId: ids.order,
          itemOperationId: ids.item,
          source: {
            kind: "browser_order",
            externalKey: input.externalKey,
            checksum: input.checksum,
          },
          evidenceChecksum: input.checksum,
          extractionRevision: input.extractionRevision,
          extraction: { status: "ready", candidate: input.candidate },
          lineIds: [ids.line],
          primaryDocumentImageId: null,
          screenshotImageId: null,
        },
      ],
    }),
    input.actor,
  );
  const productId = await input.resolveProduct();
  return commitPurchaseImport(
    db,
    commitPurchaseImportInput.parse({
      _runExecution: { runId: input.runId, operationId: ids.commit },
      prepareOperationId: ids.prepare,
      defaultTrade: "other",
      resolutions: [
        {
          stableOrderId: ids.order,
          stableLineId: ids.line,
          resolution: productId
            ? { kind: "existing", productId }
            : { kind: "new" },
        },
      ],
    }),
    input.actor,
  );
}

/** The ids a synthetic retailer order uses, keyed by the scenario token. */
export function syntheticOrderIds(token: string): BrowserOrderImport["ids"] {
  return {
    prepare: `prepare:${token}`,
    commit: `commit:${token}`,
    order: `order:${token}`,
    line: `line:${token}`,
    item: `item:${token}`,
  };
}

export const sha256Hex = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** The `describe_image` jobs finalize queued for these images. */
export function listDescribeImageJobs(
  db: Database,
  imageIds: readonly (typeof schema.imageProcessingJob.$inferSelect)["imageId"][],
) {
  return getDb(db)
    .select()
    .from(schema.imageProcessingJob)
    .where(
      and(
        inArray(schema.imageProcessingJob.imageId, imageIds),
        eq(schema.imageProcessingJob.kind, "describe_image"),
      ),
    );
}

/**
 * Complete queued `describe_image` jobs with a supplied model response. Only
 * the external model response is synthetic: the lease, executor and completion
 * fences use the real processing writers. `onRefused` lets a driver attach its
 * own diagnostic to the thrown lease error.
 */
export async function completeDescribeImageJobs(
  db: Database,
  jobs: Array<{ id: string }>,
  description: string,
  onRefused?: (jobId: string) => Promise<string>,
) {
  for (const job of jobs) {
    const claimed = await claimImageProcessingJob(db, {
      jobId: job.id,
      kinds: ["describe_image"],
      leaseMs: 60_000,
    });
    if (!claimed) {
      const detail = onRefused ? `: ${await onRefused(job.id)}` : "";
      throw new Error(`Synthetic description lease refused${detail}`);
    }
    const provider = providerFor(IMAGE_DESCRIPTION_FEATURE.model);
    const assigned = await assignImageProcessingExecutor(db, {
      jobId: claimed.id,
      attemptId: claimed.attemptId,
      executor: {
        kind: "cloud",
        deviceId: null,
        name: provider,
        platform: "cloud",
        appVersion: null,
        osVersion: null,
      },
    });
    if (!assigned) throw new Error("Synthetic description executor refused");
    const completion = await completeImageProcessingJob(db, {
      result: {
        jobId: claimed.id,
        attemptId: claimed.attemptId,
        completedAt: new Date().toISOString(),
        outcome: {
          kind: "describe_image",
          status: "completed",
          description: {
            description,
            claims: [],
            cutoutEligibility: "ineligible",
          },
          runtime: {
            platform: "cloud",
            model: IMAGE_DESCRIPTION_FEATURE.model,
          },
        },
      },
      cloudAnalysis: {
        provider,
        model: IMAGE_DESCRIPTION_FEATURE.model,
        promptRevision: IMAGE_DESCRIPTION_PROMPT_REVISION,
        resultSchemaRevision: IMAGE_DESCRIPTION_RESULT_SCHEMA_REVISION,
        inputFingerprint: imageDescriptionInputFingerprint({
          sourceContentHash: claimed.sourceContentHash,
          contentType: claimed.originalContentType,
          provider,
          model: IMAGE_DESCRIPTION_FEATURE.model,
        }),
      },
      runtime: {
        provider,
        model: IMAGE_DESCRIPTION_FEATURE.model,
        feature: "image-description",
      },
    });
    if (!completion.adopted)
      throw new Error("Synthetic description completion was not adopted");
  }
}

/** Why a describe job refused its lease: state, due time, source-hash match. */
export async function describeJobDiagnostic(db: Database, jobId: string) {
  const diagnostic = await getDb(db).execute(sql`
    SELECT j.state, j.attempts, j."nextAttemptAt" <= now() AS "due",
      j."nextAttemptAt", now() AS "databaseNow", j."lastError",
      j."attemptId" IS NOT NULL AS "hasAttempt",
      i.status AS "imageStatus", i."deletedAt" IS NOT NULL AS "imageDeleted",
      i.sha256 = j."sourceContentHash" AS "sourceMatches",
      s.metadata AS settings
    FROM "ImageProcessingJob" j JOIN "Image" i ON i.id = j."imageId"
    LEFT JOIN "AppSettings" s ON s.id = '00000000-0000-4000-8000-000000000071'
    WHERE j.id = ${jobId}
  `);
  return JSON.stringify(diagnostic.rows);
}

export interface ConvergenceScope {
  vendorId: string;
  cardId: string;
  memberId: string;
  categoryShortcode: string;
}

/** The database-side counts every arrival order must converge on. */
export async function convergenceProjection(
  db: Database,
  names: ConvergenceNames,
  scope: ConvergenceScope,
) {
  const { productName, orderId, messageId, statementAccount } = names;
  const { vendorId, cardId, memberId, categoryShortcode } = scope;
  const { rows } = await getDb(db).execute(sql`
    SELECT
      (SELECT count(*)::int FROM "Purchase" WHERE "vendorId" = ${vendorId} AND "orderId" = ${orderId} AND "deletedAt" IS NULL) AS purchases,
      (SELECT count(*)::int FROM "Product" WHERE name = ${productName} AND "deletedAt" IS NULL) AS products,
      (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS expenses,
      (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" JOIN "Product" product ON product.id = e."productId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND product.name = ${productName} AND product."deletedAt" IS NULL) AS "productLines",
      (SELECT count(*)::int FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" t ON t.id = a."transactionId" JOIN "Purchase" p ON p.id = a."purchaseId" WHERE t."accountId" = ${cardId} AND a."deletedAt" IS NULL AND t."deletedAt" IS NULL AND p."vendorId" = ${vendorId} AND p."orderId" = ${orderId} AND p."deletedAt" IS NULL) AS "settledPurchases",
      (SELECT count(*)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" JOIN "SpendingCategory" c ON c.id = ${effectiveExpenseSpendingCategorySql("e")} WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL AND c.shortcode = ${categoryShortcode} AND c."deletedAt" IS NULL) AS "categorizedExpenses",
      (SELECT round(sum(e.cost) * 100)::int FROM "Expense" e JOIN "Purchase" p ON p.id = e."purchaseId" WHERE p."vendorId" = ${vendorId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS spend,
      (SELECT count(*)::int FROM "FinancialTransaction" WHERE "accountId" = ${cardId} AND "deletedAt" IS NULL) AS transactions,
      (SELECT round(sum(a.amount) * 100)::int FROM "FinancialTransactionAllocation" a JOIN "FinancialTransaction" t ON t.id = a."transactionId" WHERE t."accountId" = ${cardId} AND a."deletedAt" IS NULL AND t."deletedAt" IS NULL) AS settlement,
      (SELECT count(*)::int FROM "InventoryEntry" i JOIN "Product" p ON p.id = i."productId" WHERE p.name = ${productName} AND i."deletedAt" IS NULL AND p."deletedAt" IS NULL) AS inventory,
      (SELECT sum(i."amountValue")::int FROM "InventoryEntry" i JOIN "Product" p ON p.id = i."productId" WHERE p.name = ${productName} AND i."deletedAt" IS NULL AND p."deletedAt" IS NULL AND i."ownershipMode" = 'person' AND i."ownerLedgerPartyId" = ${memberId}) AS "ownedQuantity",
      (SELECT count(*)::int FROM "StatementRow" WHERE "accountDescriptor" = ${statementAccount} AND "deletedAt" IS NULL) AS observations,
      (SELECT count(*)::int FROM "StatementRow" s JOIN "EntityExternalId" x ON x.source = s.source AND x."externalId" = s."externalId" AND x.kind = 'settlement_ref' AND x."deletedAt" IS NULL JOIN "FinancialTransaction" t ON t.id = x."entityId" AND t."deletedAt" IS NULL WHERE s."accountDescriptor" = ${statementAccount} AND s."deletedAt" IS NULL) AS "matchedObservations",
      (SELECT count(*)::int FROM "OrderMail" WHERE "messageId" = ${messageId}) AS mail,
      (SELECT count(*)::int FROM "OrderMailCandidateDecision" d JOIN "OrderMailEvent" e ON e.id = d."eventId" JOIN "OrderMail" m ON m.id = e."orderMailId" WHERE m."messageId" = ${messageId} AND d.decision = 'linked') AS "linkedMail"
  `);
  return rows[0];
}

/** Open Run findings on this vendor's Purchases. */
export async function openFindingCount(db: Database, vendorId: string) {
  const { rows } = await getDb(db).execute(sql`
    SELECT count(*)::int AS count FROM "RunFinding" f
    JOIN "Purchase" p ON p.id = f."entityId"
    WHERE p."vendorId" = ${vendorId} AND f.status = 'open'
  `);
  return Number(rows[0]?.count);
}

/** The Product-page #images/#labels rows for one Product. */
export async function productPhotos(db: Database, productShortcode: string) {
  const { rows } = await getDb(db).execute(sql`
    SELECT i.filename, a.purpose
    FROM "EntityAttachment" a
    JOIN "Image" i ON i.id = a."imageId" AND i."deletedAt" IS NULL
    JOIN "Product" p ON p.id = a."entityId"
    WHERE p.shortcode = ${productShortcode} AND a."deletedAt" IS NULL
    ORDER BY i.filename
  `);
  return rows;
}

/** The synthetic wardrobe photo pair a scenario uploads, with transport-neutral metadata. */
export function wardrobePhotos(
  token: string,
  readFixture: (kind: "shirt" | "label") => Uint8Array,
) {
  return (["shirt", "label"] as const).map((kind, index) => {
    const bytes = readFixture(kind);
    return {
      bytes,
      clientId: `${token}-${kind}`,
      filename: `${token}-${kind}.png`,
      contentType: "image/png" as const,
      size: bytes.length,
      width: 640,
      height: 640,
      sha256: sha256Hex(bytes),
      position: index,
    };
  });
}

/** Group proposal for the shirt+label photos, shared by the REST and writer drivers. */
export function shirtGroup(
  names: ConvergenceNames,
  images: Array<{ imageId: string }>,
  productCode: string | undefined,
  owner: { locationId: string; categoryId: string; ownerPartyId: string },
) {
  return {
    groupKey: "shirt",
    images: images.map((entry, index) => ({
      id: entry.imageId,
      purpose: index ? ("label" as const) : ("item" as const),
    })),
    product: productCode
      ? { kind: "existing" as const, existingId: productCode }
      : {
          kind: "create" as const,
          create: {
            name: names.productName,
            manufacturer: names.name,
            categoryId: owner.categoryId,
          },
        },
    inventory: {
      locationId: owner.locationId,
      quantity: 1,
      ownershipMode: "person" as const,
      ownerPartyId: owner.ownerPartyId,
    },
    evidence:
      "Synthetic own-item and label photos; identity explicitly reviewed.",
  };
}
