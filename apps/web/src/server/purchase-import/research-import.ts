import { actorInRun, buildActorContext } from "@cubby/schemas/context";
import { parseEntityId, runEntityId } from "@cubby/schemas/identifiers";
import { researchImportResult } from "@cubby/schemas/mailbox-research";
import {
  importWriterInput,
  type ExtractedOrderCandidate,
  type ImportSourceIdentity,
} from "@cubby/schemas/purchase-import";
import { researchAssessment } from "@cubby/schemas/research-assessment";
import {
  archivedResearchWorkResolve,
  researchWorkResolve,
  type ResearchWorkResolveInput,
  type ResearchWorkResolution,
} from "@cubby/schemas/research-tools";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  entityAttachment,
  entityExternalId,
  expense,
  image,
  importSourceClaim,
  mailboxMessage,
  orderMail,
  orderMailAttachment,
  orderMailCandidateDecision,
  orderMailEvent,
  product,
  purchase,
  run,
  runEvidence,
  runFinding,
  runTarget,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  getDb,
  isTransaction,
  notDeleted,
  withTransactionDatabase,
} from "~/server/repo/database-helpers";
import { lockExternalIdentifierParents } from "~/server/repo/entity-external-ids";
import { findProductNameCandidates } from "~/server/repo/product/resolve-names";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { executeAtomicOperation } from "~/server/runs/operation";
import { attachFileToEntity } from "~/server/services/image-storage.service";

import { recordAcceptedFactEvidence } from "./fact-verification";
import { productionOrderMailAttachmentStorage } from "./gmail/attachment-storage";
import {
  assertPurchaseValidationOriginal,
  loadPurchaseValidationContext,
  projectPurchaseValidation,
} from "./purchase-validation-research";
import { receiptHuntSourceIdentity } from "./receipt-evidence";
import {
  acceptedPurchaseField,
  commitAcceptedResearchFields,
  loadResearchReferenceContext,
} from "./research-accepted-fields";
import { attachmentAssessmentContext } from "./research-attachment-content";
import { researchAttemptDisposition } from "./research-attempt";
import {
  assertResearchWork,
  loadResearchEvidence,
  type ResearchEvidenceReader,
} from "./research-evidence";
import { assertMailAttachmentOriginal } from "./research-mail-attachments";
import {
  loadResearchObjectiveContext,
  reconcileResearchObjective,
  assertReceiptObjectiveOriginal,
  researchObjectiveFor,
} from "./research-objective-context";
import {
  assertResearchRunNotRetired,
  requestResearchRetention,
  withResearchSourceAdmission,
} from "./research-retention";
import { loadMailResearchSources } from "./research-run";
import type { ResearchAssessor } from "./research-support";
import { proposeVendorCaptureProfile } from "./research-vendor-profile";
import { lockPartySettlement } from "./retained-settlement";
import {
  loadImportSourceFamilyOrders,
  readImportSourceClaimFamily,
} from "./source-claim-family";
import {
  buildPurchaseImportPlan,
  importVendorOrder,
  recordImportSourceAssociation,
} from "./writer";

const retainedMailIdentity = z.object({
  orderMailId: z.uuid(),
  mailboxId: z.string().min(1),
  messageId: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
  contextOnly: z.boolean().optional(),
  attachmentRef: z.uuid().optional(),
  attachmentChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
});
const retainedPageIdentity = z.object({
  sourceURL: z.url(),
  servedURL: z.url().optional(),
  brokerAccountId: z.uuid().optional(),
});
const retainedReceiptIdentity = z.object({
  imageId: z.uuid(),
  originalChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
  attachmentRef: z.uuid(),
  attachmentChecksum: z.string().regex(/^[a-f0-9]{64}$/u),
});
type AuthorizedSource = {
  evidenceId: string;
  checksum: string;
  original: ImportSourceIdentity;
  writeAuthorized: boolean;
  mail?: typeof orderMail.$inferSelect;
  receiptImage?: typeof image.$inferSelect;
};
type ImportResearchPorts = {
  assess?: ResearchAssessor;
  readEvidence?: ResearchEvidenceReader;
  attachSource?: (
    db: Database,
    input: {
      orderMailId: string;
      purchaseId: string;
      purchaseShortcode: string;
    },
  ) => Promise<void>;
};

/** A stable host key records an assessed identity; it does not infer one. */
async function acceptedOrderLocator(candidate: ExtractedOrderCandidate) {
  return sha256Hex(
    JSON.stringify({
      merchant: candidate.merchant,
      orderedAt: candidate.orderedAt,
      currency: candidate.currency,
      total: candidate.printedGrandTotal,
      lines: candidate.lines.map((line) => ({
        title: line.title,
        quantity: line.quantity,
        amount: line.amount,
        lineKind: line.lineKind,
      })),
    }),
  );
}

async function authorizeRetainedMail(
  db: Database,
  scope: typeof run.$inferSelect,
  observation: Awaited<ReturnType<typeof loadResearchEvidence>>[number],
  frozen: Awaited<ReturnType<typeof loadMailResearchSources>>,
): Promise<AuthorizedSource> {
  const identity = retainedMailIdentity.parse(observation.metadata);
  const [mail] = await getDb(db)
    .select()
    .from(orderMail)
    .where(
      and(
        eq(orderMail.id, identity.orderMailId),
        eq(orderMail.ledgerPartyId, scope.ledgerPartyId!),
        eq(orderMail.mailboxId, identity.mailboxId),
        eq(orderMail.messageId, identity.messageId),
      ),
    );
  if (!mail)
    throw new Error("Retained mail source identity is not owned by this Run.");
  if (mail.rawChecksum !== identity.checksum)
    throw new Error("Retained mail source checksum changed.");
  if (identity.attachmentRef || identity.attachmentChecksum) {
    if (!identity.attachmentRef || !identity.attachmentChecksum)
      throw new Error(
        "Retained mail attachment original binding is incomplete.",
      );
    await assertMailAttachmentOriginal(db, {
      orderMailId: mail.id,
      attachmentRef: identity.attachmentRef,
      checksum: identity.attachmentChecksum,
    });
  }
  if (
    frozen &&
    !identity.contextOnly &&
    !frozen.some(
      (source) =>
        source.orderMailId === mail.id &&
        source.checksum === identity.checksum &&
        source.mailboxId === identity.mailboxId &&
        source.messageId === identity.messageId,
    )
  )
    throw new Error(
      "Retained source is outside this task's frozen Run originals.",
    );
  const [ownership] = identity.contextOnly
    ? []
    : await getDb(db)
        .select()
        .from(mailboxMessage)
        .where(
          and(
            eq(mailboxMessage.ledgerPartyId, scope.ledgerPartyId!),
            eq(mailboxMessage.mailboxId, mail.mailboxId),
            eq(mailboxMessage.messageId, mail.messageId),
            eq(mailboxMessage.orderMailId, mail.id),
            eq(mailboxMessage.runId, scope.id),
          ),
        );
  if (
    !identity.contextOnly &&
    (!ownership ||
      !["pending", "researching", "completed"].includes(ownership.status) ||
      ownership.checksum !== mail.rawChecksum)
  )
    throw new Error("Mail source is not live and owned by this research Run.");
  return {
    evidenceId: observation.evidenceId,
    checksum: mail.rawChecksum,
    mail,
    writeAuthorized: !identity.contextOnly && ownership?.status !== "completed",
    original: {
      kind: "mail_message",
      externalKey: `gmail:${mail.mailboxId}:${mail.messageId}`,
      checksum: mail.rawChecksum,
    },
  };
}

async function authorizeSources(
  db: Database,
  scope: typeof run.$inferSelect,
  target: typeof runTarget.$inferSelect,
  observations: Awaited<ReturnType<typeof loadResearchEvidence>>,
) {
  const frozen = await loadMailResearchSources(db, scope.id);
  const rows = observations.length
    ? await getDb(db)
        .select()
        .from(runEvidence)
        .where(
          and(
            eq(runEvidence.runId, scope.id),
            eq(runEvidence.targetId, target.id),
            inArray(
              runEvidence.id,
              observations.map((observation) => observation.evidenceId),
            ),
          ),
        )
    : [];
  const sources: AuthorizedSource[] = [];
  for (const observation of observations) {
    const evidence = rows.find((row) => row.id === observation.evidenceId);
    if (!evidence) throw new Error("Research source evidence is missing.");
    if (
      evidence.checksum !== (await sha256Hex(observation.content)) ||
      JSON.stringify(evidence.sourceMetadata) !==
        JSON.stringify(observation.metadata)
    )
      throw new Error("Retained research evidence changed before commit.");
    if (evidence.kind === "mail_message") {
      sources.push(await authorizeRetainedMail(db, scope, observation, frozen));
    } else if (evidence.kind === "upload_evidence") {
      sources.push(
        await authorizeReceiptOriginal(db, scope, target, observation),
      );
    } else if (["browser_capture", "web_page"].includes(evidence.kind)) {
      const metadata = retainedPageIdentity.parse(observation.metadata);
      if (evidence.kind === "browser_capture" && !metadata.brokerAccountId)
        throw new Error(
          "Authenticated browser capture requires an owned broker account.",
        );
      if (metadata.brokerAccountId) {
        const [account] = await getDb(db)
          .select()
          .from(vendorAccount)
          .where(
            and(
              eq(
                vendorAccount.id,
                parseEntityId("vendorAccount", metadata.brokerAccountId),
              ),
              eq(vendorAccount.ledgerPartyId, scope.ledgerPartyId!),
              notDeleted(vendorAccount),
            ),
          );
        if (!account)
          throw new Error(
            "Browser source broker account is not owned by this member.",
          );
      }
      sources.push({
        evidenceId: evidence.id,
        checksum: evidence.checksum,
        writeAuthorized: true,
        original: {
          kind: "browser_order",
          externalKey: metadata.servedURL ?? metadata.sourceURL,
          checksum: evidence.checksum,
        },
      });
    } else
      throw new Error(
        `Research evidence kind ${evidence.kind} cannot authorize an order source.`,
      );
  }
  return sources;
}

async function authorizeReceiptOriginal(
  db: Database,
  scope: typeof run.$inferSelect,
  target: typeof runTarget.$inferSelect,
  observation: Awaited<ReturnType<typeof loadResearchEvidence>>[number],
): Promise<AuthorizedSource> {
  if (scope.purpose === "purchase_validation") {
    const identity = z
      .object({
        originalEvidenceId: z.uuid(),
        originalChecksum: z.string(),
        attachmentRef: z.uuid(),
        attachmentChecksum: z.string(),
      })
      .parse(observation.metadata);
    if (
      identity.originalEvidenceId !== identity.attachmentRef ||
      identity.originalChecksum !== identity.attachmentChecksum
    )
      throw new Error("Validation retained original binding changed.");
    await assertPurchaseValidationOriginal(db, scope, target, {
      evidenceId: identity.originalEvidenceId,
      checksum: identity.originalChecksum,
    });
    await attachmentAssessmentContext([observation]);
    return {
      evidenceId: observation.evidenceId,
      checksum: identity.originalChecksum,
      original: {
        kind: "receipt_photo",
        externalKey: `validation:${scope.id}:${identity.originalEvidenceId}`,
        checksum: identity.originalChecksum,
      },
      writeAuthorized: false,
    };
  }
  const objective = researchObjectiveFor(scope, target);
  if (objective?.kind !== "receipt_hunt")
    throw new Error(
      "Receipt evidence is not selected by this research objective.",
    );
  const identity = retainedReceiptIdentity.parse(observation.metadata);
  if (
    identity.imageId !== objective.imageId ||
    identity.attachmentRef !== objective.imageId ||
    identity.originalChecksum !== objective.checksum ||
    identity.attachmentChecksum !== objective.checksum
  )
    throw new Error("Retained receipt original binding changed.");
  const { original } = await assertReceiptObjectiveOriginal(
    db,
    scope,
    objective,
  );
  await attachmentAssessmentContext([observation]);
  return {
    evidenceId: observation.evidenceId,
    checksum: objective.checksum,
    original: receiptHuntSourceIdentity({
      huntId: objective.huntId,
      checksum: objective.checksum,
    }),
    receiptImage: original,
    writeAuthorized: true,
  };
}

async function attachRetainedSource(
  db: Database,
  input: { orderMailId: string; purchaseId: string; purchaseShortcode: string },
) {
  const rows = await getDb(db)
    .select()
    .from(orderMailAttachment)
    .where(eq(orderMailAttachment.orderMailId, input.orderMailId));
  for (const attachment of rows) {
    let imageId = attachment.imageId;
    if (!imageId && attachment.pendingObjectKey) {
      const bytes = await productionOrderMailAttachmentStorage.get(
        attachment.pendingObjectKey,
      );
      const attached = await attachFileToEntity(db, {
        entityKind: "purchase",
        entityId: input.purchaseShortcode,
        data: Buffer.from(bytes).toString("base64"),
        contentType: attachment.mimeType,
        filename: attachment.filename,
        idempotencyKey: `retained-mail:${attachment.id}`,
      });
      imageId = await resolveOrThrow(db, "image", attached.imageId);
      await getDb(db)
        .update(orderMailAttachment)
        .set({ imageId, updatedAt: new Date() })
        .where(eq(orderMailAttachment.id, attachment.id));
    }
    if (imageId)
      await getDb(db)
        .insert(entityAttachment)
        .values({
          entityKind: "purchase",
          entityId: parseEntityId("purchase", input.purchaseId),
          imageId,
          role: "attachment",
          idempotencyKey: `retained-mail:${attachment.id}`,
        })
        .onConflictDoNothing();
  }
}

function orderSourceIdentity(
  source: AuthorizedSource,
  candidate: ExtractedOrderCandidate,
  locator: string,
): ImportSourceIdentity {
  return {
    ...source.original,
    externalKey:
      source.mail || source.original.kind === "receipt_photo"
        ? source.original.externalKey
        : `${source.original.externalKey}#order=${encodeURIComponent(candidate.orderId ?? locator)}`,
  };
}

/** Existing family locks precede Products; refused or missing claims remain unchanged. */
async function lockKnownSourceFamilies(
  db: Database,
  ledgerPartyId: typeof importSourceClaim.$inferSelect.ledgerPartyId,
  identities: readonly ImportSourceIdentity[],
) {
  if (!identities.length) return;
  const tx = getDb(db);
  if (!isTransaction(tx))
    throw new Error("Source family prelocks require the owning transaction.");
  const known = await tx
    .select()
    .from(importSourceClaim)
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, ledgerPartyId),
        or(
          ...identities.map((identity) =>
            and(
              eq(importSourceClaim.kind, identity.kind),
              eq(importSourceClaim.externalKey, identity.externalKey),
            ),
          ),
        ),
      ),
    );
  const lockedRoots = new Set<string>();
  for (const claim of known.sort((left, right) =>
    (left.canonicalClaimId ?? left.id).localeCompare(
      right.canonicalClaimId ?? right.id,
    ),
  )) {
    const rootId = claim.canonicalClaimId ?? claim.id;
    if (lockedRoots.has(rootId)) continue;
    const family = await readImportSourceClaimFamily(tx, claim, {
      lock: "update",
      writable: true,
    });
    if (!family)
      throw new Error("Known source family disappeared before import.");
    lockedRoots.add(rootId);
  }
}

/** Retrieval leads provide context; only the shared assessor accepts identity. */
async function addPurchaseVendorContext(
  db: Database,
  vendors: (typeof vendor.$inferSelect)[],
  purchases: readonly Pick<typeof purchase.$inferSelect, "vendorId">[],
) {
  const remainingVendorIds = [
    ...new Set(purchases.map((row) => row.vendorId)),
  ].filter((id) => !vendors.some((row) => row.id === id));
  const result = [...vendors];
  if (remainingVendorIds.length)
    result.push(
      ...(await getDb(db)
        .select()
        .from(vendor)
        .where(
          and(notDeleted(vendor), inArray(vendor.id, remainingVendorIds)),
        )),
    );
  if (result.length > 100)
    throw new Error(
      "Purchase vendor context needs a narrower research proposal.",
    );
  return result;
}

async function loadSelectedProductContext(
  db: Database,
  orders: ResearchWorkResolution["orders"],
) {
  const database = getDb(db);
  const productRefs = [
    ...new Set(
      orders.flatMap((order) =>
        (order.productResolutions ?? []).flatMap((resolution) =>
          resolution.kind === "existing" ? [resolution.productId] : [],
        ),
      ),
    ),
  ];
  if (productRefs.length > 100)
    throw new Error(
      "Product retrieval is too broad; refine the research references.",
    );
  const newProductCandidates = [];
  for (const [orderIndex, order] of orders.entries()) {
    for (const resolution of order.productResolutions ?? []) {
      if (resolution.kind !== "new") continue;
      const line = order.candidate.lines[resolution.lineIndex];
      if (!line)
        throw new Error("New Product resolution names a missing line.");
      const candidates = await findProductNameCandidates(db, line.title);
      newProductCandidates.push({
        orderIndex,
        lineIndex: resolution.lineIndex,
        productRefs: candidates.map(({ shortcode }) => shortcode),
      });
    }
  }
  const contextRefs = [
    ...new Set([
      ...productRefs,
      ...newProductCandidates.flatMap(({ productRefs }) => productRefs),
    ]),
  ];
  if (contextRefs.length > 100)
    throw new Error(
      "Product retrieval is too broad; refine the research proposal.",
    );
  const selectedProducts = contextRefs.length
    ? await database
        .select({
          id: product.id,
          productRef: product.shortcode,
          name: product.name,
          manufacturer: product.manufacturer,
          model: product.model,
          notes: product.notes,
        })
        .from(product)
        .where(
          and(notDeleted(product), inArray(product.shortcode, contextRefs)),
        )
        .orderBy(asc(product.shortcode))
    : [];
  const productIdentifiers = selectedProducts.length
    ? await database
        .select({
          productId: entityExternalId.entityId,
          source: entityExternalId.source,
          kind: entityExternalId.kind,
          externalId: entityExternalId.externalId,
          url: entityExternalId.url,
          isPrimary: entityExternalId.isPrimary,
        })
        .from(entityExternalId)
        .where(
          and(
            eq(entityExternalId.entityKind, "product"),
            notDeleted(entityExternalId),
            inArray(
              entityExternalId.entityId,
              selectedProducts.map((row) => row.id),
            ),
          ),
        )
        .orderBy(
          asc(entityExternalId.source),
          asc(entityExternalId.kind),
          asc(entityExternalId.externalId),
          asc(entityExternalId.url),
          asc(entityExternalId.isPrimary),
        )
        .limit(501)
    : [];
  if (productIdentifiers.length > 500)
    throw new Error(
      "Product identifier context needs narrower research references.",
    );
  return {
    newProductCandidates,
    productSnapshot: selectedProducts.map(({ id, productRef }) => ({
      id,
      productRef,
    })),
    products: selectedProducts.map(({ id, ...identity }) => ({
      ...identity,
      identifiers: productIdentifiers
        .filter((identifier) => identifier.productId === id)
        .map(({ productId: _productId, ...identifier }) => identifier),
    })),
    unavailableProductRefs: productRefs.filter(
      (ref) => !selectedProducts.some((row) => row.productRef === ref),
    ),
  };
}

async function lockAcceptedProductIdentities(
  db: Database,
  orders: ResearchWorkResolution["orders"],
  assessed: Pick<
    Awaited<ReturnType<typeof loadSelectedProductContext>>,
    "productSnapshot" | "products" | "unavailableProductRefs"
  >,
) {
  const tx = getDb(db);
  if (!isTransaction(tx))
    throw new Error("Product admission requires its canonical transaction.");
  const refs = [
    ...new Set(
      orders.flatMap((order) =>
        (order.productResolutions ?? []).flatMap((resolution) =>
          resolution.kind === "existing" ? [resolution.productId] : [],
        ),
      ),
    ),
  ];
  const identities = refs.map((ref) => {
    const identity = assessed.productSnapshot.find(
      (row) => row.productRef === ref,
    );
    if (!identity)
      throw new Error(
        "Accepted Product identity was unavailable during assessment.",
      );
    return identity;
  });
  if (!identities.length)
    return new Map<string, typeof product.$inferSelect.id>();
  const ids = identities.map((row) => row.id).sort();
  const locked = await tx
    .select({ id: product.id })
    .from(product)
    .where(and(inArray(product.id, ids), notDeleted(product)))
    .orderBy(asc(product.id))
    .for("update");
  if (locked.length !== ids.length)
    throw new Error("Accepted Product identity changed after assessment.");
  await lockExternalIdentifierParents(
    tx,
    identities.map((identity) => ({
      entityId: identity.id,
      entityKind: "product",
    })),
  );
  const identifiers = await tx
    .select({ id: entityExternalId.id })
    .from(entityExternalId)
    .where(
      and(
        eq(entityExternalId.entityKind, "product"),
        inArray(entityExternalId.entityId, ids),
      ),
    )
    .orderBy(asc(entityExternalId.id))
    .limit(501)
    .for("update");
  if (identifiers.length > 500)
    throw new Error(
      "Product identifier history needs narrower research references.",
    );
  const current = await loadSelectedProductContext(db, orders);
  for (const identity of identities) {
    const before = assessed.products.find(
      (row) => row.productRef === identity.productRef,
    );
    const after = current.products.find(
      (row) => row.productRef === identity.productRef,
    );
    const currentIdentity = current.productSnapshot.find(
      (row) => row.productRef === identity.productRef,
    );
    if (
      currentIdentity?.id !== identity.id ||
      JSON.stringify(before) !== JSON.stringify(after)
    )
      throw new Error("Accepted Product identity changed after assessment.");
  }
  return new Map(identities.map((row) => [row.productRef, row.id]));
}

async function loadImportSupportContext(
  db: Database,
  scope: typeof run.$inferSelect,
  target: typeof runTarget.$inferSelect,
  proposal: ResearchWorkResolution,
  sources: readonly AuthorizedSource[],
) {
  const database = getDb(db);
  const selectedProductContext = await loadSelectedProductContext(
    db,
    proposal.orders,
  );
  const escapePattern = (value: string) => value.replace(/[\\%_]/g, "\\$&");
  const vendorRefs = proposal.orders.flatMap((order) =>
    order.vendorRef ? [order.vendorRef] : [],
  );
  const vendorLeads = proposal.orders.flatMap((order) =>
    order.vendor
      ? [
          ilike(vendor.name, escapePattern(order.vendor.name)),
          ...(order.vendor.website
            ? [ilike(vendor.website, escapePattern(order.vendor.website))]
            : []),
        ]
      : [],
  );
  const vendors =
    vendorRefs.length || vendorLeads.length
      ? await database
          .select()
          .from(vendor)
          .where(
            and(
              notDeleted(vendor),
              or(
                ...(vendorRefs.length
                  ? [inArray(vendor.shortcode, vendorRefs)]
                  : []),
                ...vendorLeads,
              ),
            ),
          )
          .limit(101)
      : [];
  if (vendors.length > 100)
    throw new Error(
      "Vendor retrieval is too broad; refine the research references.",
    );
  const keys = sources.map((source) => source.original.externalKey);
  for (const order of proposal.orders) {
    const locator = await acceptedOrderLocator(order.candidate);
    for (const source of sources.filter((source) =>
      order.evidenceIds.includes(source.evidenceId),
    ))
      keys.push(
        orderSourceIdentity(source, order.candidate, locator).externalKey,
      );
  }
  const sourceAssociations = await loadImportSourceFamilyOrders(database, {
    ledgerPartyId: scope.ledgerPartyId!,
    externalKeys: keys,
  });
  if (sourceAssociations.length > 100)
    throw new Error("Source lineage needs a narrower research proposal.");
  const primaryMailIds = sources.flatMap((source) =>
    source.mail &&
    (source.mail.id === target.workKey ||
      scope.purpose === "purchase_validation")
      ? [source.mail.id]
      : [],
  );
  const humanDecisions = primaryMailIds.length
    ? await database
        .select({ decision: orderMailCandidateDecision, event: orderMailEvent })
        .from(orderMailCandidateDecision)
        .innerJoin(
          orderMailEvent,
          eq(orderMailEvent.id, orderMailCandidateDecision.eventId),
        )
        .where(inArray(orderMailEvent.orderMailId, primaryMailIds))
        .limit(101)
    : [];
  if (humanDecisions.length > 100)
    throw new Error(
      "Source review history needs a narrower research proposal.",
    );
  const purchaseRefs = [
    ...proposal.orders.flatMap((order) =>
      order.purchaseRef ? [order.purchaseRef] : [],
    ),
    ...proposal.emailLinks.map((link) => link.purchaseRef),
  ];
  const purchaseIds = [
    ...new Set([
      ...sourceAssociations.map((row) => row.association.purchaseId),
      ...humanDecisions.map((row) => row.decision.purchaseId),
      ...(target.entityKind === "purchase"
        ? [parseEntityId("purchase", target.entityId)]
        : []),
    ]),
  ];
  const orderIds = proposal.orders.flatMap((order) =>
    order.candidate.orderId ? [order.candidate.orderId] : [],
  );
  const purchaseLeads = [
    ...(purchaseRefs.length ? [inArray(purchase.shortcode, purchaseRefs)] : []),
    ...(purchaseIds.length ? [inArray(purchase.id, purchaseIds)] : []),
    ...(vendors.length && orderIds.length
      ? [
          and(
            inArray(
              purchase.vendorId,
              vendors.map((row) => row.id),
            ),
            inArray(purchase.orderId, orderIds),
          ),
        ]
      : []),
  ];
  const purchases = purchaseLeads.length
    ? await database
        .select()
        .from(purchase)
        .where(and(notDeleted(purchase), or(...purchaseLeads)))
        .limit(101)
    : [];
  if (purchases.length > 100)
    throw new Error(
      "Purchase retrieval is too broad; refine the research references.",
    );
  const contextVendors = await addPurchaseVendorContext(db, vendors, purchases);
  const expenseLines = purchases.length
    ? await database
        .select()
        .from(expense)
        .where(
          and(
            notDeleted(expense),
            inArray(
              expense.purchaseId,
              purchases.map((row) => row.id),
            ),
          ),
        )
        .limit(501)
    : [];
  if (expenseLines.length > 500)
    throw new Error(
      "Purchase line context needs a narrower research proposal.",
    );
  return {
    purpose: scope.purpose,
    ...selectedProductContext,
    vendors: contextVendors,
    purchases,
    expenseLines,
    sourceAssociations,
    humanDecisions,
  };
}

/** One semantic support decision, then one atomic canonical write boundary. */
export async function resolveImportResearch(
  db: Database,
  input: {
    runId: string;
    workRef: string;
    callId: string;
    proposal: ResearchWorkResolveInput;
  },
  ports: ImportResearchPorts = {},
) {
  const receiptInput = archivedResearchWorkResolve.parse(input.proposal);
  if (receiptInput.workRef !== input.workRef)
    throw new Error("Research proposal names a different work reference.");
  await assertResearchRunNotRetired(db, input.runId);
  // The callback keeps admission and assessment under one replay fence.
  return executeAtomicOperation(
    db,
    {
      runId: runEntityId.parse(input.runId),
      operationId: input.callId,
      kind: "research_resolve_import",
      payload: receiptInput,
      subject: "Research import",
      recordFailure: true,
      retainAttempt: true,
    },
    // eslint-disable-next-line complexity
    async (ledger) => {
      const replayed = await ledger.replay(getDb(db), researchImportResult);
      if (replayed) return replayed;
      // Removed operands may recover their sealed receipt, never a new write.
      const proposal = researchWorkResolve.parse(receiptInput);
      const { scope, target } = await assertResearchWork(
        db,
        input.runId,
        input.workRef,
      );
      if (
        !scope.ledgerPartyId ||
        !["mail_import", "account_sync", "purchase_validation"].includes(
          scope.purpose,
        )
      )
        throw new Error("Research Run cannot resolve import work.");
      if (
        scope.purpose === "purchase_validation" &&
        proposal.status === "unrelated"
      )
        throw new Error(
          "Existing Purchase validation cannot be unrelated; report ambiguity or no_source_found with the wrong-source gap.",
        );
      const validationContext =
        scope.purpose === "purchase_validation"
          ? await loadPurchaseValidationContext(db, scope, target)
          : null;
      if (scope.purpose !== "purchase_validation") {
        for (const [orderIndex, order] of proposal.orders.entries()) {
          const missing = order.candidate.lines.flatMap((line, lineIndex) =>
            line.lineKind === "principal" &&
            !order.productResolutions?.some(
              (resolution) => resolution.lineIndex === lineIndex,
            )
              ? [lineIndex]
              : [],
          );
          if (!order.productResolutions || missing.length)
            throw new Error(
              `orders[${orderIndex}].productResolutions requires a decision for each principal candidate.lines row; missing indices: ${missing.join(", ") || "none (supply [] for an incomplete order)"}.`,
            );
        }
      }
      const evidenceIds = [
        ...new Set([
          ...proposal.identity.evidenceIds,
          ...proposal.orders.flatMap((order) => order.evidenceIds),
          ...proposal.emailLinks.flatMap((link) => link.evidenceIds),
          ...proposal.facts.map((fact) => fact.evidenceId),
          ...(proposal.progress?.evidenceIds ?? []),
          ...(proposal.captureProfile?.evidenceIds ?? []),
        ]),
      ];
      const observations = await loadResearchEvidence(
        db,
        { runId: scope.id, workRef: target.id, evidenceIds },
        ports.readEvidence,
      );
      const sources = await authorizeSources(db, scope, target, observations);
      const { productSnapshot, ...context } = await loadImportSupportContext(
        db,
        scope,
        target,
        proposal,
        sources,
      );
      const assessmentInput = {
        context: {
          ...context,
          objective: await loadResearchObjectiveContext(db, scope, target),
          validation: validationContext,
          referenceValues: await loadResearchReferenceContext(db, {
            entityKind: "purchase",
            facts: proposal.facts,
          }),
        },
        observations,
        proposal,
      };
      const assessment = researchAssessment.parse(
        ports.assess
          ? await ports.assess(assessmentInput)
          : await (
              await import("./research-support")
            ).assessResearchProposal({
              db,
              runId: scope.id,
              ...assessmentInput,
            }),
      );
      if (
        scope.purpose === "purchase_validation" &&
        ["verified", "partially_verified"].includes(proposal.status) &&
        (!assessment.identityVerified || !proposal.identity.evidenceIds.length)
      )
        throw new Error(
          "Purchase identity is not supported by the retained original.",
        );
      const orders = assessment.acceptedOrders.map((index) => {
        const order = proposal.orders[index];
        if (!order)
          throw new Error("Assessment accepted a missing order operand.");
        return order;
      });
      const links = assessment.acceptedEmailLinks.map((index) => {
        const link = proposal.emailLinks[index];
        if (!link)
          throw new Error("Assessment accepted a missing mail-link operand.");
        return link;
      });
      const facts = assessment.acceptedFacts.map((index) => {
        const fact = proposal.facts[index];
        if (!fact)
          throw new Error("Assessment accepted a missing fact operand.");
        return fact;
      });
      if (
        (orders.length || links.length || facts.length) &&
        (!assessment.identityVerified ||
          proposal.identity.evidenceIds.length === 0)
      )
        throw new Error(
          "Purchase identity is not supported by the retained original.",
        );
      if (
        new Set(assessment.acceptedOrders).size !== orders.length ||
        new Set(assessment.acceptedEmailLinks).size !== links.length ||
        new Set(assessment.acceptedFacts).size !== facts.length
      )
        throw new Error("Assessment accepted duplicate operands.");
      if (scope.purpose !== "purchase_validation") {
        for (const fact of facts) {
          if (
            fact.orderIndex === undefined ||
            !assessment.acceptedOrders.includes(fact.orderIndex)
          )
            throw new Error(
              "Accepted Purchase fact is missing its accepted original order binding.",
            );
          acceptedPurchaseField.parse(fact.fieldPath);
        }
      }
      const writableSource = (source: AuthorizedSource) =>
        source.writeAuthorized &&
        (!source.mail || source.mail.id === target.workKey);
      for (const operand of [...orders, ...links])
        if (
          operand.evidenceIds.length === 0 ||
          operand.evidenceIds.some(
            (ref) =>
              !sources.some(
                (source) =>
                  source.evidenceId === ref &&
                  (scope.purpose === "purchase_validation" ||
                    writableSource(source)),
              ),
          )
        )
          throw new Error(
            "Accepted source reference is not authorized for this primary research task.",
          );
      if (
        validationContext &&
        links.some(
          (link) => link.purchaseRef !== validationContext.purchase.shortcode,
        )
      )
        throw new Error("Accepted validation link names a different Purchase.");
      const locators = await Promise.all(
        orders.map((order) => acceptedOrderLocator(order.candidate)),
      );
      const noIdKeys = orders.flatMap((order, index) =>
        order.candidate.orderId === null
          ? [`${order.vendorRef ?? order.vendor?.name}:${locators[index]}`]
          : [],
      );
      if (new Set(noIdKeys).size !== noIdKeys.length)
        throw new Error(
          "Identical no-ID orders are ambiguous; distinct identity support is required.",
        );
      if (scope.purpose !== "purchase_validation")
        for (const order of orders) {
          if (
            order.candidate.lines.some(
              (line) => line.lineKind === "principal" && line.amount < 0,
            ) ||
            (order.candidate.printedGrandTotal ?? 0) < 0
          )
            throw new Error(
              "Automatic financial reversal/refund writes are forbidden; link lifecycle evidence instead.",
            );
        }
      // Source fences, domain writes, and work completion commit together.
      // eslint-disable-next-line complexity
      const commit = async (transactionDb: Database) => {
        const tx = getDb(transactionDb);
        if (!isTransaction(tx))
          throw new Error(
            "Research import requires its owning write transaction.",
          );
        // The existing writer/settlement fence precedes Purchase and Product locks.
        await lockPartySettlement(
          tx,
          parseEntityId("ledgerParty", scope.ledgerPartyId!),
        );
        if (scope.purpose === "purchase_validation")
          await loadPurchaseValidationContext(
            transactionDb,
            scope,
            target,
            true,
          );
        const [liveRun] = await tx
          .select()
          .from(run)
          .where(and(eq(run.id, scope.id), notDeleted(run)))
          .for("update");
        const recorded = await ledger.replay(tx, researchImportResult);
        if (recorded) return recorded;
        if (!liveRun || !["running", "paused_offline"].includes(liveRun.status))
          throw new Error("Research Run is no longer writable.");
        await tx
          .select()
          .from(runTarget)
          .where(
            and(eq(runTarget.id, target.id), eq(runTarget.runId, scope.id)),
          )
          .for("update");
        await assertResearchWork(transactionDb, scope.id, target.id);
        const currentSources = await authorizeSources(
          transactionDb,
          scope,
          target,
          observations,
        );
        if (scope.purpose !== "purchase_validation")
          await lockKnownSourceFamilies(
            transactionDb,
            parseEntityId("ledgerParty", scope.ledgerPartyId!),
            [
              ...orders.flatMap((order, index) =>
                currentSources
                  .filter((source) =>
                    order.evidenceIds.includes(source.evidenceId),
                  )
                  .map((source) =>
                    orderSourceIdentity(
                      source,
                      order.candidate,
                      locators[index]!,
                    ),
                  ),
              ),
              ...links.flatMap((link) =>
                currentSources
                  .filter((source) =>
                    link.evidenceIds.includes(source.evidenceId),
                  )
                  .map((source) => source.original),
              ),
            ],
          );
        const acceptedProductIds = await lockAcceptedProductIdentities(
          transactionDb,
          orders,
          {
            products: context.products,
            unavailableProductRefs: context.unavailableProductRefs,
            productSnapshot,
          },
        );
        const mailIds = currentSources
          .filter(writableSource)
          .flatMap((source) => (source.mail ? [source.mail.id] : []));
        const historicalDecisions = mailIds.length
          ? await tx
              .select({
                decision: orderMailCandidateDecision,
                event: orderMailEvent,
              })
              .from(orderMailCandidateDecision)
              .innerJoin(
                orderMailEvent,
                eq(orderMailEvent.id, orderMailCandidateDecision.eventId),
              )
              .where(inArray(orderMailEvent.orderMailId, mailIds))
          : [];
        await ledger.start(tx);
        const purchaseIds: string[] = [];
        const productIds: string[] = [];
        const eventIds: string[] = [];
        let refused = false;
        let progressed = false;
        let hasWriteGaps = false;
        let hasMemberContradictions = false;
        if (proposal.captureProfile) {
          await proposeVendorCaptureProfile(
            tx,
            scope.id,
            target.id,
            proposal.captureProfile,
            ports.readEvidence,
          );
          progressed = true;
          hasMemberContradictions = true;
        }
        const canonicalNoIdOrders = new Set<string>();
        const acceptedPurchases = new Map<
          number,
          typeof purchase.$inferSelect
        >();
        const factRefusals: z.infer<typeof researchAssessment>["rejected"] = [];
        const sourcesFor = (refs: readonly string[]) =>
          refs.map((ref) => {
            const source = currentSources.find(
              (value) => value.evidenceId === ref,
            );
            if (!source)
              throw new Error("Research source changed before commit.");
            return source;
          });
        const preserveDecision = (
          source: AuthorizedSource,
          chosen: typeof purchase.$inferSelect,
        ) =>
          historicalDecisions.some(
            ({ decision, event }) =>
              event.orderMailId === source.mail?.id &&
              ((decision.purchaseId === chosen.id &&
                decision.decision === "dismissed") ||
                (decision.purchaseId !== chosen.id &&
                  decision.decision === "linked" &&
                  (event.orderId === null ||
                    event.orderId === chosen.orderId))),
          );
        const linkMail = async (
          source: AuthorizedSource,
          chosen: typeof purchase.$inferSelect,
          event: string,
          proof:
            | ResearchWorkResolution["orders"][number]
            | ResearchWorkResolution["emailLinks"][number],
        ) => {
          if (!source.mail) return;
          const sourceKey = await sha256Hex(
            JSON.stringify({
              purchaseId: chosen.id,
              event,
              checksum: source.checksum,
            }),
          );
          const payload = {
            researchRunId: scope.id,
            workRef: target.id,
            proof,
          };
          const [createdEvent] = await tx
            .insert(orderMailEvent)
            .values({
              orderMailId: source.mail.id,
              event,
              orderId: chosen.orderId,
              sourceKey,
              payload,
            })
            .onConflictDoNothing()
            .returning();
          const [retainedEvent] = createdEvent
            ? [createdEvent]
            : await tx
                .update(orderMailEvent)
                .set({ payload })
                .where(
                  and(
                    eq(orderMailEvent.orderMailId, source.mail.id),
                    eq(orderMailEvent.sourceKey, sourceKey),
                  ),
                )
                .returning();
          if (!retainedEvent)
            throw new Error("Research mail event was not persisted.");
          const [createdDecision] = await tx
            .insert(orderMailCandidateDecision)
            .values({
              eventId: retainedEvent.id,
              purchaseId: chosen.id,
              decision: "linked",
              evidenceChecksum: source.checksum,
              decidedByUserId: scope.actorUserId,
            })
            .onConflictDoNothing()
            .returning({ id: orderMailCandidateDecision.id });
          progressed ||= Boolean(createdEvent || createdDecision);
          eventIds.push(retainedEvent.id);
          await (ports.attachSource ?? attachRetainedSource)(transactionDb, {
            orderMailId: source.mail.id,
            purchaseId: chosen.id,
            purchaseShortcode: chosen.shortcode,
          });
        };
        if (scope.purpose !== "purchase_validation") {
          for (const [index, order] of orders.entries()) {
            const selectedSources = sourcesFor(order.evidenceIds);
            let chosen = order.purchaseRef
              ? context.purchases.find(
                  (row) => row.shortcode === order.purchaseRef,
                )
              : undefined;
            if (order.purchaseRef && !chosen)
              throw new Error("Supported Purchase reference was not found.");
            let vendorId = order.vendorRef
              ? await resolveOrThrow(transactionDb, "vendor", order.vendorRef)
              : chosen?.vendorId;
            if (!vendorId && order.vendor) {
              const matching = await tx
                .select()
                .from(vendor)
                .where(
                  and(eq(vendor.name, order.vendor.name), notDeleted(vendor)),
                );
              if (matching.length > 1)
                throw new Error("Accepted Vendor identity is ambiguous.");
              vendorId =
                matching[0]?.id ??
                (
                  await insertWithShortcode(transactionDb, "vendor", {
                    name: order.vendor.name,
                    website: order.vendor.website ?? null,
                  })
                ).id;
            }
            if (!vendorId)
              throw new Error(
                "Accepted order has no supported Vendor identity.",
              );
            if (order.candidate.orderId === null) {
              const canonicalIdentity = `${vendorId}:${locators[index]}`;
              if (canonicalNoIdOrders.has(canonicalIdentity))
                throw new Error(
                  "Identical no-ID orders for this Vendor are ambiguous; distinct supported identity is required.",
                );
              canonicalNoIdOrders.add(canonicalIdentity);
            }
            if (!chosen && order.candidate.orderId) {
              const matches = await tx
                .select()
                .from(purchase)
                .where(
                  and(
                    eq(purchase.vendorId, vendorId),
                    eq(purchase.orderId, order.candidate.orderId),
                    notDeleted(purchase),
                  ),
                )
                .for("update");
              if (matches.length > 1)
                throw new Error(
                  "Accepted order identity matches multiple Purchases.",
                );
              chosen = matches[0];
            }
            if (
              chosen &&
              selectedSources.some((source) =>
                preserveDecision(source, chosen!),
              )
            ) {
              refused = true;
              continue;
            }
            const firstSource = selectedSources[0];
            if (!firstSource)
              throw new Error("Accepted order source is missing.");
            const sourceIdentity = (source: AuthorizedSource) =>
              orderSourceIdentity(source, order.candidate, locators[index]!);
            const productResolutions = order.productResolutions
              ? order.productResolutions.map((resolution) => {
                  if (resolution.kind !== "existing") return resolution;
                  const productId = acceptedProductIds.get(
                    resolution.productId,
                  );
                  if (!productId)
                    throw new Error(
                      "Accepted Product identity is unavailable.",
                    );
                  return { ...resolution, productId };
                })
              : undefined;
            const writerInput = importWriterInput.parse({
              runId: scope.id,
              ledgerPartyId: scope.ledgerPartyId,
              vendorId,
              vendorAccountId: null,
              targetPurchaseId: chosen?.id,
              orderLocator: locators[index],
              source: sourceIdentity(firstSource),
              extraction: { status: "ready", candidate: order.candidate },
              productResolutions,
              primaryDocumentImageId:
                selectedSources.find((source) => source.receiptImage)
                  ?.receiptImage?.id ?? null,
              screenshotImageId: null,
            });
            hasWriteGaps ||=
              buildPurchaseImportPlan(writerInput.extraction)
                .writeBlockReason !== null;
            const imported = await importVendorOrder(
              transactionDb,
              writerInput,
              scope.actorUserId,
              { applyUnassignedPurposeFallback: true },
            );
            if (!imported.purchaseId || imported.outcome === "conflict")
              throw new Error(
                "Supported order conflicts with existing Purchase state.",
              );
            progressed ||= imported.outcome !== "replayed";
            if (imported.findingIds.length) {
              const pendingFindings = await tx
                .select({ kind: runFinding.kind })
                .from(runFinding)
                .where(
                  and(
                    inArray(runFinding.id, imported.findingIds),
                    eq(runFinding.status, "open"),
                  ),
                );
              hasWriteGaps ||= pendingFindings.some(
                (finding) => finding.kind !== "arrived",
              );
            }
            [chosen] = await tx
              .select()
              .from(purchase)
              .where(
                eq(purchase.id, parseEntityId("purchase", imported.purchaseId)),
              );
            if (!chosen) throw new Error("Imported Purchase was not found.");
            purchaseIds.push(chosen.id);
            for (const source of selectedSources) {
              await recordImportSourceAssociation(
                tx,
                {
                  ...writerInput,
                  source: sourceIdentity(source),
                  orderId: order.candidate.orderId,
                },
                chosen.id,
                imported.outputFingerprint,
              );
              await linkMail(source, chosen, order.event, order);
            }
            // Assessment indices name the original proposal, never this filtered roster.
            acceptedPurchases.set(assessment.acceptedOrders[index]!, chosen);
            const lines = await tx
              .select({ productId: expense.productId })
              .from(expense)
              .where(
                and(eq(expense.purchaseId, chosen.id), notDeleted(expense)),
              );
            productIds.push(
              ...lines.flatMap((line) =>
                line.productId ? [line.productId] : [],
              ),
            );
          }
          for (const link of links) {
            const purchaseId = await resolveOrThrow(
              transactionDb,
              "purchase",
              link.purchaseRef,
            );
            const [chosen] = await tx
              .select()
              .from(purchase)
              .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
              .for("update");
            if (!chosen?.vendorId)
              throw new Error("Supported lifecycle Purchase has no Vendor.");
            for (const source of sourcesFor(link.evidenceIds)) {
              if (preserveDecision(source, chosen)) {
                refused = true;
                continue;
              }
              if (!source.mail)
                throw new Error(
                  "Email lifecycle links require retained mail originals.",
                );
              await recordImportSourceAssociation(
                tx,
                {
                  runId: scope.id,
                  ledgerPartyId: scope.ledgerPartyId!,
                  vendorId: chosen.vendorId,
                  vendorAccountId: null,
                  orderId: chosen.orderId,
                  orderLocator: chosen.id,
                  source: source.original,
                },
                chosen.id,
                await sha256Hex(JSON.stringify(link)),
              );
              await linkMail(source, chosen, link.event, link);
              purchaseIds.push(chosen.id);
            }
          }
        }
        if (scope.purpose !== "purchase_validation") {
          const actor = actorInRun(
            buildActorContext(scope.actorUserId, scope.channel),
            scope.id,
          );
          for (const orderIndex of assessment.acceptedOrders) {
            const claims = facts.filter(
              (fact) => fact.orderIndex === orderIndex,
            );
            if (!claims.length) continue;
            const chosen = acceptedPurchases.get(orderIndex);
            if (!chosen) {
              factRefusals.push(
                ...claims.map((fact) => ({
                  path: `orders[${orderIndex}].${fact.fieldPath}`,
                  reason:
                    "The accepted order was refused by an existing member decision; no fact was written or verified.",
                })),
              );
              continue;
            }
            // Distinct supported operands may resolve to the same Purchase.
            const [current] = await tx
              .select()
              .from(purchase)
              .where(and(eq(purchase.id, chosen.id), notDeleted(purchase)))
              .for("update");
            if (!current)
              throw new Error(
                "Accepted Purchase disappeared before fact verification.",
              );
            const committed = await commitAcceptedResearchFields(tx, {
              entityKind: "purchase",
              entityId: chosen.id,
              live: current,
              claims,
              actor,
              referenceAssessment: {
                facts: proposal.facts,
                values: assessmentInput.context.referenceValues,
              },
            });
            hasMemberContradictions ||= committed.contradictions.length > 0;
            factRefusals.push(
              ...committed.refusals.map((refusal) => ({
                ...refusal,
                path: `orders[${orderIndex}].${refusal.path}`,
              })),
              ...committed.contradictions.map((contradiction) => ({
                path: `orders[${orderIndex}].${contradiction.fieldPath}`,
                reason: `Accepted source value ${JSON.stringify(contradiction.proposedValue)} contradicts the existing value ${JSON.stringify(contradiction.currentValue)}; member review is required.`,
              })),
            );
            const proof = await recordAcceptedFactEvidence(tx, {
              runId: scope.id,
              targetId: target.id,
              subject: { entityKind: "purchase", entityId: chosen.id },
              claims: committed.claims,
            });
            progressed ||=
              committed.changedFields.size > 0 || proof.inserted > 0;
          }
        }
        const validationProjection =
          scope.purpose === "purchase_validation"
            ? await projectPurchaseValidation(transactionDb, {
                scope,
                target,
                operationId: input.callId,
                orders,
                facts,
                evidenceIds,
              })
            : null;
        const objective = researchObjectiveFor(scope, target);
        const verifiedScopeCompletion = Boolean(
          objective &&
          ["account_history", "vendor_purchases"].includes(objective.kind) &&
          proposal.progress?.scopeExhausted &&
          assessment.scopeCompletionVerified,
        );
        const candidateStatus =
          (["verified", "partially_verified"].includes(proposal.status) &&
            orders.length + links.length + facts.length === 0 &&
            !verifiedScopeCompletion) ||
          validationProjection?.needsReview ||
          refused ||
          hasWriteGaps ||
          factRefusals.length ||
          assessment.rejected.length ||
          orders.length !== proposal.orders.length ||
          links.length !== proposal.emailLinks.length ||
          facts.length !== proposal.facts.length
            ? "researched_with_gaps"
            : proposal.status;
        const refusals = [...assessment.rejected, ...factRefusals];
        const attempt = await researchAttemptDisposition(tx, {
          runId: scope.id,
          workRef: target.id,
          outcome: candidateStatus,
          progress: progressed,
          correctable:
            !validationProjection?.needsReview &&
            !hasMemberContradictions &&
            !refused &&
            !hasWriteGaps &&
            ["verified", "partially_verified"].includes(proposal.status) &&
            (refusals.length > 0 ||
              orders.length !== proposal.orders.length ||
              links.length !== proposal.emailLinks.length ||
              facts.length !== proposal.facts.length ||
              (!orders.length &&
                !links.length &&
                !facts.length &&
                !verifiedScopeCompletion)),
          refusals,
        });
        const objectiveResolution = attempt.retry
          ? { status: attempt.outcome, warning: proposal.detail }
          : await reconcileResearchObjective(transactionDb, {
              scope,
              target,
              proposal,
              assessment,
              status: attempt.outcome,
            });
        const status = objectiveResolution.status;
        const retirement =
          status === "unrelated"
            ? await requestResearchRetention(transactionDb, {
                runId: scope.id,
                workRef: target.id,
                callId: input.callId,
                hasSupportedWrites: Boolean(
                  orders.length ||
                  links.length ||
                  facts.length ||
                  purchaseIds.length ||
                  productIds.length ||
                  eventIds.length,
                ),
              })
            : null;
        const result = researchImportResult.parse({
          status,
          purchaseIds: [...new Set(purchaseIds)],
          productIds: [...new Set(productIds)],
          eventIds: [...new Set(eventIds)],
          retirement: retirement ? { receiptId: retirement.receiptId } : null,
          proposedOrders: scope.purpose === "purchase_validation" ? orders : [],
          proposedLinks: scope.purpose === "purchase_validation" ? links : [],
          proposedFacts: facts,
          refusals,
        });
        await tx
          .update(runTarget)
          .set({
            state: attempt.retry
              ? "needs_evidence"
              : status === "verified" || status === "unrelated"
                ? "completed"
                : "unresolved",
            outcome: attempt.retry ? null : status,
            warning:
              status === "unrelated"
                ? null
                : (validationProjection?.warning ??
                  objectiveResolution.warning),
            completedAt: attempt.retry ? null : new Date(),
            updatedAt: new Date(),
          })
          .where(eq(runTarget.id, target.id));
        if (mailIds.length && scope.purpose !== "purchase_validation")
          await tx
            .update(mailboxMessage)
            .set({
              status: attempt.retry
                ? "researching"
                : [
                      "verified",
                      "partially_verified",
                      "researched_with_gaps",
                    ].includes(status) && purchaseIds.length
                  ? "completed"
                  : "blocked",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(mailboxMessage.runId, scope.id),
                inArray(mailboxMessage.orderMailId, mailIds),
              ),
            );
        await ledger.complete(
          tx,
          validationProjection?.review
            ? {
                ...result,
                validationReview: validationProjection.review,
                attempt: proposal,
                correctionAttempt: attempt.correctionAttempt,
              }
            : {
                ...result,
                attempt: proposal,
                correctionAttempt: attempt.correctionAttempt,
              },
          retirement
            ? { retirementReceiptId: retirement.receiptId }
            : undefined,
        );
        return result;
      };
      return scope.purpose === "mail_import"
        ? withResearchSourceAdmission(
            db,
            {
              runId: scope.id,
              workRef: target.id,
            },
            commit,
          )
        : withTransactionDatabase(db, commit);
    },
  );
}
