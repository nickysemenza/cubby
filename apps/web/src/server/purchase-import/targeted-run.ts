import type {
  LedgerPartyId,
  ProductId,
  PurchaseId,
  VendorId,
} from "@cubby/schemas/identifiers";
import { runShortcode, vendorAccountId } from "@cubby/schemas/identifiers";
import { agentImportRunPurpose } from "@cubby/schemas/import-run-agent";
import type { PurchaseAgentEvent } from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { and, desc, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import {
  type TargetedImportLaunch,
  targetedImportPurpose,
  type TargetedImportPurpose,
  type TargetedImportStartInput,
  type TargetedImportStartOutput,
} from "~/contracts/run.contract";
import { getPurchaseAgentQueue } from "~/server/cf-env";
import type { Database } from "~/server/db";
import {
  entityExternalId,
  expense,
  importSourceClaim,
  product,
  purchase,
  vendor,
  vendorAccount,
} from "~/server/db/schema";
import {
  browsingAccountFor,
  browsingAccounts,
} from "~/server/purchase-import/browsing-account";
import {
  dispatchRunEvent,
  recordRunDispatchAttempt,
} from "~/server/purchase-import/dispatch";
import { productEnrichmentTarget } from "~/server/purchase-import/product-enrichment-target";
import { startTargetedRun } from "~/server/purchase-import/run-service";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";

type SourceClaim = {
  id: string;
  kind: string;
  externalKey: string;
  checksum: string;
  outputFingerprint: string;
  vendorAccountId: string | null;
  vendorAccountLabel: string | null;
  vendorId: VendorId;
  vendorShortcode: string;
};

type TargetFingerprintInput =
  | {
      purchaseId: string;
      updatedAt: Date;
      source: string | null;
    }
  /** A Product that was not found; a live one uses `productEnrichmentTarget`. */
  | { product: undefined };

const fingerprint = (value: TargetFingerprintInput) =>
  sha256Hex(JSON.stringify(value));

/**
 * Hand a committed run to the coordinator queue. A missing queue or a failed
 * send is recorded on the run as `dispatch_failed`, never thrown, so the
 * browser can offer the dispatch recovery controls.
 */
export async function dispatchStartedRun(
  db: Database,
  run: {
    id: string;
    eventId: string;
    purpose: string;
  },
): Promise<"running" | "dispatch_failed"> {
  const queue = getPurchaseAgentQueue();
  if (!queue) {
    await recordRunDispatchAttempt(db, {
      runId: run.id,
      eventId: run.eventId,
      error: "Purchase import agent queue is unavailable",
    });
    return "dispatch_failed";
  }
  try {
    const event: Extract<PurchaseAgentEvent, { type: "start_or_resume" }> = {
      version: 1,
      runId: run.id,
      purpose: agentImportRunPurpose.parse(run.purpose),
      eventId: run.eventId,
      type: "start_or_resume",
    };
    await dispatchRunEvent(db, queue, event);
    return "running";
  } catch {
    return "dispatch_failed";
  }
}

async function queueStartedRun(
  db: Database,
  run: {
    id: string;
    publicId: string;
    status: string;
    purpose: string;
    dispatchEventId: string | null;
  },
) {
  if (!run.dispatchEventId)
    throw new Error("Targeted import run has no dispatch event");
  const status = await dispatchStartedRun(db, {
    id: run.id,
    eventId: run.dispatchEventId,
    purpose: run.purpose,
  });
  return {
    id: runShortcode.parse(run.publicId),
    status,
    purpose: targetedImportPurpose.parse(run.purpose),
    dispatchEventId: run.dispatchEventId,
  };
}

async function startedOutcome(
  db: Database,
  started: Awaited<ReturnType<typeof startTargetedRun>>,
): Promise<TargetedImportStartOutput["runs"][number]> {
  if (!started.created) {
    // Only an `admit` narrowing leaves no blocking run; manual starts pass none.
    if (!started.blockingRun)
      throw new Error("Targeted import run admitted no targets");
    return {
      created: false,
      run: null,
      blockingRun: {
        id: runShortcode.parse(started.blockingRun.publicId),
        status: started.blockingRun.status,
      },
    };
  }
  return {
    created: true,
    run: await queueStartedRun(db, started.run),
    blockingRun: null,
  };
}

async function claimsForPurchase(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  purchaseId: PurchaseId,
): Promise<SourceClaim[]> {
  return await getDb(db)
    .select({
      id: importSourceClaim.id,
      kind: importSourceClaim.kind,
      externalKey: importSourceClaim.externalKey,
      checksum: importSourceClaim.checksum,
      outputFingerprint: importSourceClaim.outputFingerprint,
      vendorAccountId: importSourceClaim.vendorAccountId,
      vendorAccountLabel: vendorAccount.label,
      vendorId: vendor.id,
      vendorShortcode: vendor.shortcode,
    })
    .from(importSourceClaim)
    .innerJoin(purchase, eq(purchase.id, importSourceClaim.purchaseId))
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importSourceClaim.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .where(
      and(
        eq(importSourceClaim.ledgerPartyId, ledgerPartyId),
        eq(importSourceClaim.purchaseId, purchaseId),
      ),
    )
    .orderBy(desc(importSourceClaim.updatedAt));
}

async function claimForActor(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  claimId: string,
) {
  const parsedClaimId = z.uuid().safeParse(claimId);
  if (!parsedClaimId.success) return null;
  const [claim] = await getDb(db)
    .select({
      id: importSourceClaim.id,
      kind: importSourceClaim.kind,
      externalKey: importSourceClaim.externalKey,
      checksum: importSourceClaim.checksum,
      outputFingerprint: importSourceClaim.outputFingerprint,
      purchaseId: importSourceClaim.purchaseId,
      vendorAccountId: importSourceClaim.vendorAccountId,
      vendorId: vendor.id,
      vendorShortcode: vendor.shortcode,
    })
    .from(importSourceClaim)
    .innerJoin(purchase, eq(purchase.id, importSourceClaim.purchaseId))
    .innerJoin(
      vendor,
      and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
    )
    .where(
      and(
        eq(importSourceClaim.id, parsedClaimId.data),
        eq(importSourceClaim.ledgerPartyId, ledgerPartyId),
      ),
    )
    .limit(1);
  return claim ?? null;
}

const claimLabel = (claim: { kind: string; externalKey: string }) =>
  `${claim.kind.replaceAll("_", " ")} · ${claim.externalKey}`;

/** The sources a targeted run could replay for one Purchase or Product. */
export async function loadTargetedImportLaunch(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  purpose: TargetedImportPurpose,
  targetId: string,
): Promise<TargetedImportLaunch> {
  if (purpose === "purchase_validation") {
    const purchaseId = await resolveOrThrow(db, "purchase", targetId);
    const [target] = await getDb(db)
      .select({
        shortcode: purchase.shortcode,
        displayLabel: purchase.displayLabel,
        orderId: purchase.orderId,
        vendorName: vendor.name,
      })
      .from(purchase)
      .innerJoin(
        vendor,
        and(eq(vendor.id, purchase.vendorId), notDeleted(vendor)),
      )
      .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
      .limit(1);
    if (!target) throw new Error("Target was not found");
    const claims = await claimsForPurchase(db, ledgerPartyId, purchaseId);
    return {
      purpose,
      purchase: {
        id: target.shortcode,
        label: target.displayLabel ?? target.orderId ?? target.vendorName,
        canValidate: true,
        reason:
          claims.length > 0
            ? null
            : "No replayable claim exists; the run will search Gmail, then use an owned browser account when available.",
        sources: claims.map((claim, index) => ({
          id: claim.id,
          label: claimLabel(claim),
          kind: claim.kind,
          fingerprint: claim.checksum,
          vendorAccountId: claim.vendorAccountId,
          vendorAccountLabel: claim.vendorAccountLabel,
          usable: true,
          reason: null,
          default: index === 0 && claim.kind === "browser_order",
        })),
        products: [],
      },
      products: [],
    };
  }

  const productId = await resolveOrThrow(db, "product", targetId);
  const [target] = await getDb(db)
    .select({ name: product.name })
    .from(product)
    .where(and(eq(product.id, productId), notDeleted(product)))
    .limit(1);
  if (!target) throw new Error("Target was not found");
  const [claim] = await getDb(db)
    .select({
      id: importSourceClaim.id,
      kind: importSourceClaim.kind,
      externalKey: importSourceClaim.externalKey,
      vendorAccountId: importSourceClaim.vendorAccountId,
      vendorAccountLabel: vendorAccount.label,
    })
    .from(expense)
    .innerJoin(
      purchase,
      and(eq(purchase.id, expense.purchaseId), notDeleted(purchase)),
    )
    .innerJoin(
      importSourceClaim,
      and(
        eq(importSourceClaim.purchaseId, purchase.id),
        eq(importSourceClaim.ledgerPartyId, ledgerPartyId),
      ),
    )
    .leftJoin(
      vendorAccount,
      and(
        eq(vendorAccount.id, importSourceClaim.vendorAccountId),
        notDeleted(vendorAccount),
      ),
    )
    .where(and(eq(expense.productId, productId), notDeleted(expense)))
    .orderBy(desc(importSourceClaim.updatedAt))
    .limit(1);
  return {
    purpose,
    purchase: null,
    products: [
      {
        productId: targetId,
        productName: target.name,
        selected: Boolean(claim),
        sourceId: claim?.id ?? null,
        sourceLabel: claim ? claimLabel(claim) : null,
        vendorAccountId: claim?.vendorAccountId ?? null,
        vendorAccountLabel: claim?.vendorAccountLabel ?? null,
        needsAccountChoice: false,
        accountChoices: [],
        reason: claim ? null : "No verified purchase source is available.",
      },
    ],
  };
}

async function startPurchaseValidation(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: Extract<TargetedImportStartInput, { purpose: "purchase_validation" }>,
): Promise<TargetedImportStartOutput> {
  const purchaseId = await resolveOrThrow(db, "purchase", input.purchaseId);
  const claim = input.sourceId
    ? await claimForActor(db, ledgerPartyId, input.sourceId)
    : null;
  if (claim && claim.purchaseId !== purchaseId)
    throw new Error("Choose a current replayable source");
  const [purchaseScope] = await getDb(db)
    .select({
      vendorId: purchase.vendorId,
      vendorAccountId: purchase.vendorAccountId,
      orderId: purchase.orderId,
      updatedAt: purchase.updatedAt,
    })
    .from(purchase)
    .where(and(eq(purchase.id, purchaseId), notDeleted(purchase)))
    .limit(1);
  if (!purchaseScope?.vendorId || !purchaseScope.orderId)
    throw new Error("Purchase needs a Vendor and order ID");
  const accountId = claim?.vendorAccountId
    ? vendorAccountId.parse(claim.vendorAccountId)
    : purchaseScope.vendorAccountId
      ? vendorAccountId.parse(purchaseScope.vendorAccountId)
      : null;
  const started = await startTargetedRun(db, {
    ledgerPartyId,
    purpose: "purchase_validation",
    vendorId: claim?.vendorId ?? purchaseScope.vendorId,
    vendorAccountId: accountId,
    trigger: "manual",
    targets: [
      {
        kind: "purchase",
        purchaseId,
        vendorAccountId: accountId,
        sourceKind: claim?.kind ?? null,
        sourceExternalKey: claim?.externalKey ?? purchaseScope.orderId,
        targetFingerprint: await fingerprint({
          purchaseId,
          updatedAt: purchaseScope.updatedAt,
          source: claim?.outputFingerprint ?? null,
        }),
        evidenceFingerprint: claim?.checksum ?? null,
      },
    ],
  });
  return { runs: [await startedOutcome(db, started)] };
}

/**
 * The page an enrichment run opens first: the first HTTP(S) candidate on the
 * Vendor's browser domains, because the browser bridge refuses any other
 * navigation. Candidates in order: the given pages (a browser-captured
 * claim's order page, or the import line's product page), the Product's
 * learned pages (primary first), the Vendor's website. A Gmail or receipt
 * claim's key names no page and is never used. Null when none is on the
 * Vendor's browser domains.
 */
export async function enrichmentStartPage(
  db: Database,
  input: {
    productId: ProductId;
    vendorId: VendorId;
    pages: readonly (string | null | undefined)[];
  },
) {
  const vendorRow = await vendorPages(db, input.vendorId);
  const learned = await getDb(db)
    .select({ url: entityExternalId.url })
    .from(entityExternalId)
    .where(
      and(
        eq(entityExternalId.entityId, input.productId),
        isNotNull(entityExternalId.url),
        notDeleted(entityExternalId),
      ),
    )
    .orderBy(desc(entityExternalId.isPrimary));
  const candidates = [
    ...input.pages,
    ...learned.map((page) => page.url),
    vendorRow.website,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      // SILENT: a claim key or malformed website is not a page; try the next.
      continue;
    }
    if (
      (url.protocol === "https:" || url.protocol === "http:") &&
      vendorRow.allowed.has(url.hostname.toLowerCase())
    )
      return url.href;
  }
  return null;
}

async function vendorPages(db: Database, vendorId: VendorId) {
  const [owner] = await getDb(db)
    .select({
      name: vendor.name,
      website: vendor.website,
      browserDomains: vendor.browserDomains,
    })
    .from(vendor)
    .where(eq(vendor.id, vendorId))
    .limit(1);
  return {
    name: owner?.name,
    website: owner?.website,
    allowed: new Set(owner?.browserDomains.map((host) => host.toLowerCase())),
  };
}

async function enrichmentStartUrl(
  db: Database,
  productId: ProductId,
  claim: Pick<
    NonNullable<Awaited<ReturnType<typeof claimForActor>>>,
    "externalKey" | "vendorId"
  >,
) {
  const page = await enrichmentStartPage(db, {
    productId,
    vendorId: claim.vendorId,
    pages: [claim.externalKey],
  });
  if (page) return page;
  const owner = await vendorPages(db, claim.vendorId);
  throw new Error(
    `No page to start enriching this Product is on ${owner.name ?? "its Vendor"}'s browser domains (${[...owner.allowed].join(", ") || "none"}). Add the site's host to the Vendor's browser domains or a website on one of them.`,
  );
}

async function startProductEnrichment(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: Extract<TargetedImportStartInput, { purpose: "product_enrichment" }>,
): Promise<TargetedImportStartOutput> {
  const resolved = await Promise.all(
    input.targets.map(async (target) => {
      const productId = await resolveOrThrow(db, "product", target.productId);
      const claim = target.sourceId
        ? await claimForActor(db, ledgerPartyId, target.sourceId)
        : null;
      const productState = await productEnrichmentTarget(getDb(db), productId);
      const [sourceLine] = claim?.purchaseId
        ? await getDb(db)
            .select({ id: expense.id })
            .from(expense)
            .where(
              and(
                eq(expense.purchaseId, claim.purchaseId),
                eq(expense.productId, productId),
                notDeleted(expense),
              ),
            )
            .limit(1)
        : [];
      if (!claim || !sourceLine)
        throw new Error(
          "Every product needs a verified source that contains it",
        );
      return {
        productId,
        claim,
        startUrl: await enrichmentStartUrl(db, productId, claim),
        targetFingerprint:
          productState?.fingerprint ??
          (await fingerprint({ product: undefined })),
      };
    }),
  );
  // A mail or receipt claim may name no account, or a mail-only one; the
  // run browses with the Vendor's browsing account when there is one.
  const accounts = await browsingAccounts(
    db,
    resolved.map((row) => row.claim.vendorId),
  );
  const groups = new Map<string, typeof resolved>();
  for (const row of resolved) {
    const vendorAccountId =
      browsingAccountFor(accounts, row.claim)?.id ?? row.claim.vendorAccountId;
    row.claim = { ...row.claim, vendorAccountId };
    const key = `${row.claim.vendorId}:${vendorAccountId ?? "none"}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const runs = await Promise.all(
    [...groups.values()].map(async (group) => {
      const { claim } = group[0]!;
      const started = await startTargetedRun(db, {
        ledgerPartyId,
        purpose: "product_enrichment",
        vendorId: claim.vendorId,
        vendorAccountId: claim.vendorAccountId
          ? vendorAccountId.parse(claim.vendorAccountId)
          : null,
        trigger: "manual",
        targets: group.map((row) => ({
          kind: "product" as const,
          productId: row.productId,
          vendorAccountId: row.claim.vendorAccountId
            ? vendorAccountId.parse(row.claim.vendorAccountId)
            : null,
          sourceKind: row.claim.kind,
          // The enrichment agent opens this; a mail claim's key is no page.
          sourceExternalKey: row.startUrl,
          targetFingerprint: row.targetFingerprint,
          evidenceFingerprint: row.claim.checksum,
        })),
      });
      return startedOutcome(db, started);
    }),
  );
  return { runs };
}

/** Admit and dispatch targeted validation or enrichment runs. */
export function startTargetedImport(
  db: Database,
  ledgerPartyId: LedgerPartyId,
  input: TargetedImportStartInput,
): Promise<TargetedImportStartOutput> {
  return input.purpose === "purchase_validation"
    ? startPurchaseValidation(db, ledgerPartyId, input)
    : startProductEnrichment(db, ledgerPartyId, input);
}
