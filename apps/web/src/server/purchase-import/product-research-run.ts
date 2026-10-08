import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type {
  LedgerPartyId,
  ProductId,
  RunId,
  UserId,
  VendorAccountId,
} from "@cubby/schemas/identifiers";
import { runEntityId, userId } from "@cubby/schemas/identifiers";
import {
  coordinatorModelFor,
  importRunAgentIdentity,
} from "@cubby/schemas/import-run-agent";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { productResearchRunInput } from "@cubby/schemas/run-fields";
import { ACTIVE_RUN_STATUSES } from "@cubby/shared/client-constants";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database, DrizzleClient, DrizzleTransaction } from "~/server/db";
import {
  auditLog,
  entityAttachment,
  entityExternalId,
  expense,
  image,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  ledgerParty,
  product,
  purchase,
  run,
  runTarget,
  vendorAccount,
  user,
} from "~/server/db/schema";
import type { PurchaseAgentQueueProducer } from "~/server/purchase-agent-queue-types";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { runAfterCommit } from "~/server/repo/database-helpers/core";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { assertRunParent } from "~/server/runs/ensure-run";
import { inheritExecutionAuthorization } from "~/server/runs/execution-context";

import { dispatchRunEvent, recordRunDispatchAttempt } from "./dispatch";
import { productEnrichmentTarget } from "./product-enrichment-target";
import {
  readResearchContinuationSuccessor,
  researchContinuationAdmission,
  type ResearchContinuation,
} from "./research-continuation-admission";
import { loadProductResearchCoverage } from "./research-projection";
import {
  researchRetirementAdmission,
  readResearchRetirementSuccessor,
} from "./research-retention-admission";
import {
  loadImportSourceClaimRoots,
  readImportSourceClaimFamily,
  readSourceFamilyOrder,
} from "./source-claim-family";

/** Bump when the curated Product research instructions materially change. */
const PRODUCT_RESEARCH_INSTRUCTION_REVISION = 1;

type Executor = DrizzleClient | DrizzleTransaction;

/** Original purchase context, independent of optional browser transport. */
export async function purchasedResearchProducts(
  executor: Executor,
  options: {
    productIds?: readonly ProductId[];
    purchaseIds?: readonly (typeof purchase.$inferSelect.id)[];
    vendorAccountIds?: readonly VendorAccountId[];
  } = {},
) {
  const fields = {
    productId: product.id,
    purchaseId: purchase.id,
    vendorAccountId: purchase.vendorAccountId,
    expenseId: expense.id,
    name: expense.name,
    url: expense.url,
    quantity: expense.productQuantity,
    orderId: purchase.orderId,
    vendorId: purchase.vendorId,
  };
  const baseFilters = and(
    notDeleted(product),
    notDeleted(purchase),
    options.productIds
      ? inArray(product.id, [...options.productIds])
      : undefined,
    options.purchaseIds
      ? inArray(purchase.id, [...options.purchaseIds])
      : undefined,
    options.vendorAccountIds
      ? inArray(purchase.vendorAccountId, [...options.vendorAccountIds])
      : undefined,
  );
  const retained = await executor
    .select({
      ...fields,
      ledgerPartyId: importSourceClaim.ledgerPartyId,
      userId: ledgerParty.userId,
      parentRunId: importSourceClaim.lastRunId,
      sourceId: importSourceClaim.id,
      sourceOrderId: importSourceOrder.id,
      sourceKind: importSourceClaim.kind,
      sourceKey: importSourceClaim.externalKey,
      checksum: importSourceClaim.checksum,
      orderChecksum: importSourceOrder.checksum,
      outputFingerprint: importSourceOrder.outputFingerprint,
    })
    .from(product)
    .innerJoin(expense, eq(expense.productId, product.id))
    .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
    .innerJoin(importSourceOrder, eq(importSourceOrder.purchaseId, purchase.id))
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importSourceClaim.ledgerPartyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(and(baseFilters, notDeleted(expense)));
  const snapshotBound = await executor
    .select({
      productId: product.id,
      purchaseId: purchase.id,
      vendorAccountId: purchase.vendorAccountId,
      orderId: purchase.orderId,
      vendorId: purchase.vendorId,
      ledgerPartyId: importSourceClaim.ledgerPartyId,
      userId: ledgerParty.userId,
      parentRunId: importSourceClaim.lastRunId,
      sourceId: importSourceClaim.id,
      sourceOrderId: importSourceOrder.id,
      sourceKind: importSourceClaim.kind,
      sourceKey: importSourceClaim.externalKey,
      checksum: importSourceClaim.checksum,
      orderChecksum: importSourceOrder.checksum,
      outputFingerprint: importSourceOrder.outputFingerprint,
      originalOrder: importSourceOrder.originalOrder,
      originalLineIndex: importSourceProduct.lineIndex,
    })
    .from(product)
    .innerJoin(
      importSourceProduct,
      eq(importSourceProduct.productId, product.id),
    )
    .innerJoin(
      importSourceOrder,
      eq(importSourceOrder.id, importSourceProduct.sourceOrderId),
    )
    .innerJoin(purchase, eq(purchase.id, importSourceOrder.purchaseId))
    .innerJoin(
      importSourceClaim,
      eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, importSourceClaim.ledgerPartyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        baseFilters,
        sql`NOT EXISTS (
      SELECT 1 FROM "Expense" e WHERE e."purchaseId" = ${purchase.id} AND e."productId" = ${product.id} AND e."deletedAt" IS NULL
    )`,
      ),
    );
  const originalProducts = snapshotBound.flatMap(
    ({ originalOrder, originalLineIndex, ...row }) => {
      const original = acceptedSourceOrder.parse(originalOrder);
      const line = original.extraction.candidate?.lines[originalLineIndex];
      return line
        ? [
            {
              ...row,
              expenseId: null,
              name: line.title,
              url: line.productUrl ?? null,
              quantity: line.quantity ?? null,
            },
          ]
        : [];
    },
  );
  const legacy = await executor
    .select({
      ...fields,
      ledgerPartyId: ledgerParty.id,
      userId: ledgerParty.userId,
      parentRunId: run.id,
      auditId: auditLog.id,
    })
    .from(product)
    .innerJoin(expense, eq(expense.productId, product.id))
    .innerJoin(purchase, eq(purchase.id, expense.purchaseId))
    .innerJoin(
      auditLog,
      and(
        eq(auditLog.entityKind, "purchase"),
        eq(auditLog.entityId, purchase.id),
      ),
    )
    .innerJoin(
      run,
      and(
        eq(run.id, auditLog.runId),
        inArray(run.purpose, ["account_sync", "mail_import"]),
        notDeleted(run),
      ),
    )
    .innerJoin(
      ledgerParty,
      and(
        eq(ledgerParty.id, run.ledgerPartyId),
        eq(ledgerParty.kind, "member"),
        notDeleted(ledgerParty),
      ),
    )
    .where(
      and(
        baseFilters,
        notDeleted(expense),
        sql`(
      NOT EXISTS (SELECT 1 FROM "AuditLog" a WHERE a."entityKind" = 'product' AND a."entityId" = ${product.id} AND a."action" = 'create')
      OR EXISTS (SELECT 1 FROM "AuditLog" a JOIN "Run" r ON r."id" = a."runId"
        WHERE a."entityKind" = 'product' AND a."entityId" = ${product.id} AND a."action" = 'create'
          AND r."purpose" IN ('account_sync', 'mail_import') AND r."ledgerPartyId" = ${ledgerParty.id} AND r."deletedAt" IS NULL)
    )`,
      ),
    );
  const sourceProducts = [...retained, ...originalProducts];
  const roots = await loadImportSourceClaimRoots(
    executor,
    sourceProducts.map((row) => ({
      id: row.sourceId,
      ledgerPartyId: row.ledgerPartyId,
      kind: row.sourceKind,
      externalKey: row.sourceKey,
    })),
  );
  return [
    ...sourceProducts.map((row) => {
      const root = roots.get(row.sourceId);
      if (!root) throw new Error("Retained Product source root is missing.");
      return { ...row, sourceKey: root.externalKey, checksum: root.checksum };
    }),
    ...legacy,
  ];
}

type ResearchStartInput = {
  ledgerPartyId: LedgerPartyId;
  userId: UserId;
  productIds: readonly ProductId[];
  selectedSources?: readonly {
    productId: ProductId;
    sourceOrderId: typeof importSourceOrder.$inferSelect.id;
  }[];
  preferredBrowserAccountId?: VendorAccountId;
  parentRunId?: RunId;
  retirementReceiptId?: string;
  continuation?: ResearchContinuation;
  cause?: "member_request" | "scheduled";
};

async function lockSelectedSources(
  tx: DrizzleTransaction,
  ownerId: LedgerPartyId,
  selectedSources: NonNullable<ResearchStartInput["selectedSources"]>,
) {
  const sourceIds = [
    ...new Set(selectedSources.map((source) => source.sourceOrderId)),
  ].sort();
  const selected = sourceIds.length
    ? await tx
        .select({
          id: importSourceOrder.id,
          checksum: importSourceOrder.checksum,
          orderKey: importSourceOrder.orderKey,
          claim: importSourceClaim,
        })
        .from(importSourceOrder)
        .innerJoin(
          importSourceClaim,
          eq(importSourceClaim.id, importSourceOrder.sourceClaimId),
        )
        .where(
          and(
            inArray(importSourceOrder.id, sourceIds),
            eq(importSourceClaim.ledgerPartyId, ownerId),
          ),
        )
        .orderBy(asc(importSourceOrder.id))
    : [];
  if (selected.length !== sourceIds.length)
    throw new Error(
      "Choose a current owned source that contains this Product.",
    );
  const families = new Map<
    string,
    NonNullable<Awaited<ReturnType<typeof readImportSourceClaimFamily>>>
  >();
  // Match the writer's root-before-association lock order across source families.
  for (const source of [...selected].sort((left, right) =>
    (left.claim.canonicalClaimId ?? left.claim.id).localeCompare(
      right.claim.canonicalClaimId ?? right.claim.id,
    ),
  )) {
    const rootId = source.claim.canonicalClaimId ?? source.claim.id;
    if (families.has(rootId)) continue;
    const family = await readImportSourceClaimFamily(tx, source.claim, {
      lock: "share",
    });
    if (!family)
      throw new Error(
        "Choose a current owned source that contains this Product.",
      );
    families.set(rootId, family);
  }
  for (const source of selected) {
    const family = families.get(
      source.claim.canonicalClaimId ?? source.claim.id,
    )!;
    const current = await readSourceFamilyOrder(
      tx,
      family,
      source.orderKey,
      "share",
    );
    if (
      !current ||
      current.association.id !== source.id ||
      current.association.checksum !== family.root.checksum
    )
      throw new Error(
        "Choose a current owned source that contains this Product.",
      );
  }
}

async function lockPreferredBrowserAccount(
  tx: DrizzleTransaction,
  ownerId: LedgerPartyId,
  accountId: ResearchStartInput["preferredBrowserAccountId"],
) {
  if (!accountId) return null;
  const [account] = await tx
    .select({ id: vendorAccount.id })
    .from(vendorAccount)
    .where(
      and(
        eq(vendorAccount.id, accountId),
        eq(vendorAccount.ledgerPartyId, ownerId),
        eq(vendorAccount.browser, "chrome"),
        eq(vendorAccount.browserSyncEnabled, true),
        ne(vendorAccount.status, "disabled"),
        notDeleted(vendorAccount),
      ),
    )
    .for("share");
  if (!account)
    throw new Error(
      "Preferred browser transport is not a current owned Chrome account.",
    );
  return account.id;
}

function assertProductSourceScope(
  ids: readonly ProductId[],
  live: readonly (typeof product.$inferSelect)[],
  selectedSources: NonNullable<ResearchStartInput["selectedSources"]>,
  sourcesFor: (
    id: ProductId,
  ) => Awaited<ReturnType<typeof purchasedResearchProducts>>,
  cause: ResearchStartInput["cause"],
) {
  for (const source of selectedSources)
    if (
      !ids.includes(source.productId) ||
      !sourcesFor(source.productId).some(
        (context) =>
          "sourceOrderId" in context &&
          context.sourceOrderId === source.sourceOrderId,
      )
    )
      throw new Error(
        "Choose a current owned source that contains this Product.",
      );
  for (const id of ids)
    if (
      !live.some((row) => row.id === id) ||
      (cause !== "member_request" && !sourcesFor(id).length)
    )
      throw new Error(
        "Product is not linked to an owned retained purchase source",
      );
}

function launchMetadata(
  input: ResearchStartInput,
  continuation: Awaited<ReturnType<typeof researchRetirementAdmission>>,
  clientKey: string,
): Pick<
  typeof run.$inferInsert,
  | "trigger"
  | "cause"
  | "attempt"
  | "parentRunId"
  | "predecessorRunId"
  | "clientKey"
> {
  if (continuation)
    return {
      trigger: "manual",
      cause: "retry",
      attempt: continuation.attempt,
      parentRunId: continuation.parentRunId,
      predecessorRunId: continuation.predecessorRunId,
      clientKey: continuation.clientKey,
    };
  return {
    clientKey,
    trigger: input.cause === "scheduled" ? "scheduled" : "manual",
    cause:
      input.cause === "member_request"
        ? "member_request"
        : input.parentRunId
          ? "import_completed"
          : (input.cause ?? "member_request"),
    attempt: 1,
    parentRunId: input.parentRunId ?? null,
    predecessorRunId: null,
  };
}

function assertProductAdmissionMode(input: ResearchStartInput) {
  if (input.continuation && input.retirementReceiptId)
    throw new Error("Choose ordinary continuation or a retirement receipt.");
}

/** Admission is serialized on the owner and live Products; prior tasks stay immutable. */
export async function admitProductResearch(
  db: Database,
  input: ResearchStartInput,
) {
  const admitted = await withTransaction(db, async (tx) => {
    const [owner] = await tx
      .select({
        id: ledgerParty.id,
        shortcode: ledgerParty.shortcode,
        name: ledgerParty.name,
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
      })
      .from(ledgerParty)
      .innerJoin(user, eq(user.id, ledgerParty.userId))
      .where(
        and(
          eq(ledgerParty.id, input.ledgerPartyId),
          eq(ledgerParty.userId, input.userId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      // Serialize admission while allowing source claims to reference this member.
      .for("no key update", { of: ledgerParty });
    if (!owner)
      throw new Error("Product research member ownership is unavailable");
    assertProductAdmissionMode(input);
    const ordinarySuccessor = await readResearchContinuationSuccessor(tx, {
      continuation: input.continuation,
      ledgerPartyId: owner.id,
      actorUserId: userId.parse(owner.userId),
      purpose: "product_enrichment",
    });
    if (ordinarySuccessor) return [{ run: ordinarySuccessor, created: false }];
    if (input.parentRunId) {
      await assertRunParent(tx, input.parentRunId, {
        ledgerPartyId: owner.id,
        actorUserId: userId.parse(owner.userId),
      });
    }
    const continuation =
      (await researchContinuationAdmission(tx, {
        continuation: input.continuation,
        ledgerPartyId: owner.id,
        actorUserId: userId.parse(owner.userId),
        purpose: "product_enrichment",
        taskKeys: input.productIds,
      })) ??
      (await researchRetirementAdmission(tx, {
        receiptId: input.retirementReceiptId,
        parentRunId: input.parentRunId,
        ledgerPartyId: owner.id,
        actorUserId: userId.parse(owner.userId),
        purpose: "product_enrichment",
        taskKeys: input.productIds,
      }));
    const existingSuccessor = await readResearchRetirementSuccessor(
      tx,
      continuation,
    );
    if (existingSuccessor) return [{ run: existingSuccessor, created: false }];
    const ids = [...new Set(input.productIds)].sort();
    if (!ids.length) return [];
    if (ids.length > 50)
      throw new Error(
        "Product research admits at most 50 Products per request",
      );
    const selectedSources = input.selectedSources ?? [];
    await lockSelectedSources(tx, owner.id, selectedSources);
    const preferredBrowserAccountId = await lockPreferredBrowserAccount(
      tx,
      owner.id,
      input.preferredBrowserAccountId,
    );
    const live = await tx
      .select()
      .from(product)
      .where(and(inArray(product.id, ids), notDeleted(product)))
      .orderBy(asc(product.id))
      .for("update");
    const contexts = await purchasedResearchProducts(tx, { productIds: ids });
    const sourcesFor = (id: ProductId) =>
      contexts.filter(
        (row) =>
          row.productId === id &&
          row.ledgerPartyId === owner.id &&
          row.userId === input.userId,
      );
    assertProductSourceScope(
      ids,
      live,
      selectedSources,
      sourcesFor,
      input.cause,
    );
    const prior = await tx
      .select({ target: runTarget, run })
      .from(runTarget)
      .innerJoin(run, eq(run.id, runTarget.runId))
      .where(
        and(
          eq(runTarget.entityKind, "product"),
          inArray(runTarget.entityId, ids),
          eq(run.purpose, "product_enrichment"),
          eq(run.ledgerPartyId, owner.id),
          notDeleted(run),
        ),
      );
    const rows: { run: typeof run.$inferSelect; created: boolean }[] = [];
    const eligible: {
      productId: ProductId;
      contextFingerprint: string;
      targetFingerprint: string;
      evidenceFingerprint: string;
    }[] = [];
    for (const item of live) {
      const holding = prior.find(
        (row) =>
          row.target.entityId === item.id &&
          (row.run.status === "dispatch_failed" ||
            ACTIVE_RUN_STATUSES.some((status) => status === row.run.status)),
      );
      if (holding) {
        if (!rows.some((row) => row.run.id === holding.run.id))
          rows.push({ run: holding.run, created: false });
        continue;
      }
      const identifiers = await tx
        .select({
          id: entityExternalId.id,
          source: entityExternalId.source,
          kind: entityExternalId.kind,
          value: entityExternalId.externalId,
        })
        .from(entityExternalId)
        .where(
          and(
            eq(entityExternalId.entityKind, "product"),
            eq(entityExternalId.entityId, item.id),
            notDeleted(entityExternalId),
          ),
        )
        .orderBy(asc(entityExternalId.id));
      const images = await tx
        .select({
          id: entityAttachment.id,
          imageId: image.id,
          key: image.key,
          source: image.source,
          url: image.sourceAssetUrl,
          order: entityAttachment.sortOrder,
        })
        .from(entityAttachment)
        .innerJoin(
          image,
          and(eq(image.id, entityAttachment.imageId), notDeleted(image)),
        )
        .where(
          and(
            eq(entityAttachment.entityKind, "product"),
            eq(entityAttachment.entityId, item.id),
            notDeleted(entityAttachment),
          ),
        )
        .orderBy(asc(entityAttachment.id));
      const sources = sourcesFor(item.id)
        .map(({ parentRunId: _parent, userId: _user, ...row }) => row)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const evidenceFingerprint = await sha256Hex(
        JSON.stringify({
          instructionRevision: PRODUCT_RESEARCH_INSTRUCTION_REVISION,
          name: item.name,
          sources,
        }),
      );
      const sameOriginalContext = prior.some(
        (row) =>
          row.target.entityId === item.id &&
          row.target.evidenceFingerprint === evidenceFingerprint,
      );
      if (
        sameOriginalContext &&
        (
          await loadProductResearchCoverage(tx, {
            productId: item.id,
            ledgerPartyId: owner.id,
          })
        ).complete
      )
        continue;
      const contextFingerprint = await sha256Hex(
        JSON.stringify({
          instructionRevision: PRODUCT_RESEARCH_INSTRUCTION_REVISION,
          product: {
            name: item.name,
            ...Object.fromEntries(
              entityFieldModels.product.research.fillFields.map((field) => [
                field,
                item[field],
              ]),
            ),
          },
          identifiers,
          images,
          sources,
        }),
      );
      const attempted = prior.some((row) => {
        const parsed = productResearchRunInput.safeParse(row.run.input);
        return (
          row.target.entityId === item.id &&
          parsed.success &&
          parsed.data.products.some(
            (entry) =>
              entry.productId === item.id &&
              entry.contextFingerprint === contextFingerprint,
          )
        );
      });
      if (attempted && !continuation) continue;
      const target = await productEnrichmentTarget(tx, item.id);
      if (target)
        eligible.push({
          productId: item.id,
          contextFingerprint,
          targetFingerprint: target.fingerprint,
          evidenceFingerprint,
        });
    }
    if (eligible.length) {
      const id = runEntityId.parse(crypto.randomUUID());
      const typedInput = productResearchRunInput.parse({
        kind: "product_research",
        instructionRevision: PRODUCT_RESEARCH_INSTRUCTION_REVISION,
        products: eligible.map(({ productId, contextFingerprint }) => ({
          productId,
          contextFingerprint,
        })),
      });
      const metadata = launchMetadata(
        input,
        continuation,
        `product-research:${owner.id}:${await sha256Hex(JSON.stringify(typedInput))}`,
      );
      const created = await insertWithShortcode(tx, "run", {
        id,
        ledgerPartyId: owner.id,
        actorUserId: userId.parse(owner.userId),
        actorName: owner.userName ?? owner.name,
        actorEmail: owner.userEmail,
        actorLedgerPartyShortcode: owner.shortcode,
        actorLedgerPartyName: owner.name,
        actorLedgerPartyKind: "member",
        purpose: "product_enrichment",
        ...metadata,
        vendorAccountId: preferredBrowserAccountId,
        input:
          (await inheritExecutionAuthorization(tx, typedInput, metadata)) ??
          null,
        dispatchEventId: crypto.randomUUID(),
        coordinatorModel: coordinatorModelFor("product_enrichment"),
        agentSessionId: importRunAgentIdentity(id, "product_enrichment"),
      });
      await tx.insert(runTarget).values(
        eligible.map((entry) => ({
          runId: id,
          entityKind: "product" as const,
          entityId: entry.productId,
          workKey: entry.productId,
          state: "pending" as const,
          targetFingerprint: entry.targetFingerprint,
          evidenceFingerprint: entry.evidenceFingerprint,
        })),
      );
      rows.push({ run: created, created: true });
    }
    return rows;
  });
  return admitted;
}

export async function startProductResearch(
  db: Database,
  input: ResearchStartInput,
  queue?: PurchaseAgentQueueProducer,
) {
  const admitted = await admitProductResearch(db, input);
  const result = admitted.map((row) => ({
    runId: row.run.id,
    status: row.run.status,
    created: row.created,
  }));
  for (const row of admitted) {
    if (
      !row.created &&
      row.run.status !== "dispatch_failed" &&
      row.run.dispatchAttempts > 0
    )
      continue;
    const eventId = row.run.dispatchEventId;
    if (!eventId)
      throw new Error("Product research dispatch generation is missing");
    await runAfterCommit(db, async (committedDb) => {
      const producer = queue ?? getPurchaseAgentQueue();
      if (!producer) {
        const settled = await recordRunDispatchAttempt(committedDb, {
          runId: row.run.id,
          eventId,
          error: "Purchase research queue is unavailable",
        });
        const summary = result.find((entry) => entry.runId === row.run.id);
        if (summary) summary.status = settled.status;
        return;
      }
      try {
        await dispatchRunEvent(committedDb, producer, {
          version: 1,
          type: "start_or_resume",
          runId: row.run.id,
          purpose: "product_enrichment",
          eventId,
        });
      } catch {
        // SILENT: dispatchRunEvent retained the failure on this generation for recovery.
        const summary = result.find((entry) => entry.runId === row.run.id);
        if (summary) summary.status = "dispatch_failed";
      }
      const [settled] = await getDb(committedDb)
        .select({ status: run.status })
        .from(run)
        .where(and(eq(run.id, row.run.id), eq(run.dispatchEventId, eventId)));
      const summary = result.find((entry) => entry.runId === row.run.id);
      if (summary && settled) summary.status = settled.status;
    });
  }
  return result;
}
